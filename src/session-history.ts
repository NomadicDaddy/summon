import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

import { atomicWrite, errorCode, locked, missing } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import { providers, storageRoot } from './store.ts';

export const SESSION_HISTORY_LIMIT = 2000;
const MAX_BYTES = 2 * 1024 * 1024;
export const sessionTransitionInput = z
	.object({
		member: z
			.string()
			.max(64)
			.regex(/^[a-z0-9][a-z0-9._-]*$/),
		provider: z.enum(providers),
		nonce: z.uuid(),
		previousNonce: z.uuid().optional(),
		pid: z.number().int().positive().optional(),
		state: z.enum(['started', 'stop-requested', 'stopped', 'exited', 'stop-failed']),
		reason: z.enum([
			'operator',
			'rest-work',
			'mention',
			'recovery',
			'unhibernate',
			'window-close',
			'unknown',
		]),
		exitCode: z.number().int().optional(),
	})
	.strict();
export type SessionTransitionInput = z.infer<typeof sessionTransitionInput>;
const recordSchema = sessionTransitionInput
	.extend({
		id: z.uuid(),
		at: z.iso.datetime(),
		windowStartedAt: z.iso.datetime(),
	})
	.strict();
export type SessionTransition = z.infer<typeof recordSchema>;
const documentSchema = z
	.object({
		version: z.literal(1),
		entries: z.array(recordSchema).max(SESSION_HISTORY_LIMIT),
	})
	.strict();

async function checked(path: string, directory: boolean, lock = false): Promise<boolean> {
	try {
		const value = await lstat(path);
		if (
			value.isSymbolicLink() ||
			(directory ? !value.isDirectory() : !value.isFile() || (!lock && value.nlink !== 1))
		)
			throw new Error('Session history storage is redirected or has an unexpected type.');
		if (!directory && !lock && value.size > MAX_BYTES)
			throw new Error('Session history exceeds its fixed size limit.');
		return true;
	} catch (error: unknown) {
		if (missing(error)) return false;
		throw error;
	}
}

async function location(root: string, create: boolean): Promise<string | undefined> {
	if (!(await checked(root, true))) {
		if (!create) return;
		throw new Error('Session history team root is missing.');
	}
	const logs = join(root, 'logs');
	if (!(await checked(logs, true))) {
		if (!create) return;
		await mkdir(logs).catch((error: unknown) => {
			if (errorCode(error) !== 'EEXIST') throw error;
		});
		await checked(logs, true);
	}
	return join(logs, 'session-history.json');
}

async function entries(path: string): Promise<SessionTransition[]> {
	if (!(await checked(path, false))) return [];
	try {
		return documentSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown).entries;
	} catch {
		throw new Error('Session history is damaged; existing evidence was not overwritten.');
	}
}

/** Only the owning Team Window writes lifecycle evidence; no message or terminal text is accepted. */
export async function appendSessionTransition(
	input: SessionTransitionInput,
	windowStartedAt: string,
	teamRoot: string,
	observedAt = new Date().toISOString(),
): Promise<void> {
	operatorOnly();
	const root = resolve(teamRoot);
	const record = recordSchema.parse({
		...sessionTransitionInput.parse(input),
		id: randomUUID(),
		at: observedAt,
		windowStartedAt,
	});
	if (!(await checked(root, true))) throw new Error('Session history team root is missing.');
	const lock = join(root, 'session-history.lock');
	await checked(lock, false, true);
	await locked(lock, async () => {
		const path = await location(root, true);
		if (!path) throw new Error('Session history unavailable.');
		const retained = [...(await entries(path)), record].slice(-SESSION_HISTORY_LIMIT);
		const body = JSON.stringify({ version: 1, entries: retained });
		if (Buffer.byteLength(body) > MAX_BYTES)
			throw new Error('Session history exceeds its fixed size limit.');
		await atomicWrite(path, body);
	});
}

export async function readSessionHistory(options: {
	limit: number;
	member?: string;
	before?: string;
}) {
	const path = await location(resolve(storageRoot()), false);
	const retained = path ? await entries(path) : [];
	let matching = retained.filter(
		(entry) => options.member === undefined || entry.member === options.member,
	);
	if (options.before) {
		const index = matching.findIndex((entry) => entry.id === options.before);
		if (index < 0)
			throw new Error(
				'Session history cursor expired or does not match this member; start the read again.',
			);
		matching = matching.slice(0, index);
	}
	const page = matching.slice(-options.limit).reverse();
	return {
		readOnly: true,
		snapshotOnly: true,
		entries: page,
		more: matching.length > options.limit,
		next: matching.length > options.limit ? (page.at(-1)?.id ?? null) : null,
		retainedTransitions: retained.length,
		maximumTransitions: SESSION_HISTORY_LIMIT,
		maximumBytes: MAX_BYTES,
		oldestRetainedAt: retained[0]?.at ?? null,
	};
}

export async function sessionHistoryCommand(args: string[]): Promise<void> {
	const options: { limit: number; member?: string; before?: string } = { limit: 50 };
	const used = new Set<string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key || !value || used.has(key))
			throw new Error(
				'Usage: summon --session-history [--limit 1..200] [--member name] [--before id]',
			);
		used.add(key);
		if (key === '--limit')
			options.limit = z.number().int().min(1).max(200).parse(Number(value));
		else if (key === '--member')
			options.member = sessionTransitionInput.shape.member.parse(value);
		else if (key === '--before') options.before = z.uuid().parse(value);
		else throw new Error('Unknown session history reader option.');
	}
	console.log(JSON.stringify(await readSessionHistory(options)));
}
