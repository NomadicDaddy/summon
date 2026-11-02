import { lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import type { WakeOutcome } from './wake-delivery-store.ts';

import { atomicWrite, errorCode, LockBusyError } from './mail-files.ts';
import { runtimePath } from './mail-session.ts';
import { NotificationNotSentError } from './notification-delivery.ts';
import { parseOwner, processAlive } from './process-owner.ts';

/** The call boundary where a wake delivery threw; never an inferred provider cause. */
export type WakeBoundary =
	| 'after-send'
	| 'mark-attempted'
	| 'notice-paused'
	| 'other'
	| 'ownership-boundary'
	| 'send'
	| 'watchdog-retention';

const lockSample = z
	.object({
		ageBucket: z.enum([
			'<1m',
			'1-10m',
			'10-60m',
			'>60m',
			'stat-absent',
			'stat-denied',
			'stat-error',
		]),
		lock: z.enum([
			'probe-alive',
			'probe-absent',
			'owner-unparsed',
			'lock-absent',
			'read-denied',
			'read-error',
		]),
	})
	.strict();
const failureSchema = z
	.object({
		attempts: z.number().int().nonnegative(),
		category: z.enum([
			'watchdog-retention',
			'mark-attempted',
			'ownership-boundary',
			'notice-paused',
			'send-refused',
			'send-uncertain',
			'after-send',
			'other',
		]),
		lastFailureAt: z.iso.datetime(),
		sampledAfterFailure: lockSample.optional(),
		version: z.literal(1),
	})
	.strict();
type LockSample = z.infer<typeof lockSample>;
type WakeFailure = z.infer<typeof failureSchema>;
type ShownFailure = Pick<WakeFailure, 'category' | 'sampledAfterFailure'>;
const SIDECAR_LIMIT = 4096;

/** Beside the outcome; old readers never open it, so the outcome schema stays unchanged. */
export const failurePath = (owner: string, id: string): string =>
	join(runtimePath(owner), 'wake-deliveries', `${id}.failure.json`);

/** Best effort, after the durable outcome save: it never changes state or the thrown error. */
export async function recordWakeFailure(
	value: WakeOutcome,
	boundary: WakeBoundary,
	error: unknown,
): Promise<void> {
	try {
		if (!value.lastFailureAt) return;
		const failure: WakeFailure = {
			attempts: value.attempts,
			category: category(boundary, error),
			lastFailureAt: value.lastFailureAt,
			version: 1,
		};
		if (error instanceof LockBusyError)
			failure.sampledAfterFailure = await sampleLock(error.path);
		await atomicWrite(
			failurePath(value.owner, value.id),
			JSON.stringify(failureSchema.parse(failure)),
		);
	} catch {
		/* Diagnostics never reach a delivery decision. */
	}
}

function category(boundary: WakeBoundary, error: unknown): WakeFailure['category'] {
	if (boundary !== 'send') return boundary;
	return error instanceof NotificationNotSentError ? 'send-refused' : 'send-uncertain';
}

function observed(error: unknown): 'absent' | 'denied' | 'error' {
	const code = errorCode(error);
	if (code === 'ENOENT') return 'absent';
	return code === 'EACCES' || code === 'EPERM' ? 'denied' : 'error';
}

/** One read and one lstat, taken after the refusal: not the holder at the moment of refusal. */
async function sampleLock(path: string): Promise<LockSample> {
	try {
		return { ageBucket: await lockAge(path), lock: await lockOwner(path) };
	} catch {
		return { ageBucket: 'stat-error', lock: 'read-error' };
	}
}

async function lockOwner(path: string): Promise<LockSample['lock']> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error: unknown) {
		const seen = observed(error);
		if (seen === 'absent') return 'lock-absent';
		return seen === 'denied' ? 'read-denied' : 'read-error';
	}
	const owner = parseOwner(text);
	if (!owner) return 'owner-unparsed';
	// process.kill(pid, 0) is positive or indeterminate, never proof of a live owner.
	return processAlive(owner.pid) ? 'probe-alive' : 'probe-absent';
}

async function lockAge(path: string): Promise<LockSample['ageBucket']> {
	let minutes: number;
	try {
		minutes = (Date.now() - (await lstat(path)).mtimeMs) / 60_000;
	} catch (error: unknown) {
		return `stat-${observed(error)}`;
	}
	if (minutes < 1) return '<1m';
	if (minutes < 10) return '1-10m';
	return minutes < 60 ? '10-60m' : '>60m';
}

/**
 * The current failure when attempts and lastFailureAt both match, else a previous failure once
 * recovered (a successful retry moves attempts on). Anything else is omitted as "not recorded".
 */
export async function wakeFailureProjection(value: WakeOutcome): Promise<{
	failure?: ShownFailure;
	previousFailure?: ShownFailure & { recoveredAt: string };
}> {
	const failure = await readFailure(value);
	if (!failure || failure.lastFailureAt !== value.lastFailureAt) return {};
	const shown: ShownFailure = {
		category: failure.category,
		...(failure.sampledAfterFailure
			? { sampledAfterFailure: failure.sampledAfterFailure }
			: {}),
	};
	if (['not-sent', 'uncertain'].includes(value.state) && failure.attempts === value.attempts)
		return { failure: shown };
	if (value.recoveredAt) return { previousFailure: { ...shown, recoveredAt: value.recoveredAt } };
	return {};
}

/** One bounded read and a strict parse; any failure is omission, never an error. */
async function readFailure(value: WakeOutcome): Promise<undefined | WakeFailure> {
	try {
		const handle = await open(failurePath(value.owner, value.id), 'r');
		try {
			const buffer = Buffer.alloc(SIDECAR_LIMIT + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > SIDECAR_LIMIT) return undefined;
			return failureSchema.parse(
				JSON.parse(buffer.toString('utf8', 0, bytesRead)) as unknown,
			);
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}
