import { afterEach, beforeEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { WakePart } from '../../src/wake-part.ts';

import { runtimePath } from '../../src/mail-session.ts';
import { mailHarness } from './mail-harness.ts';

/** A disposable team store with alpha as the acting agent, restored after every test. */
export function useWakeFixture(): void {
	let fixture: Awaited<ReturnType<typeof mailHarness>>;
	const previous = {
		home: process.env.SUMMON_HOME,
		agent: process.env.SUMMON_AGENT,
		nonce: process.env.SUMMON_NONCE,
	};
	beforeEach(async () => {
		fixture = await mailHarness();
		process.env.SUMMON_HOME = fixture.records;
		process.env.SUMMON_AGENT = 'alpha';
		process.env.SUMMON_NONCE = 'wake-failure-fixture';
	});
	afterEach(async () => {
		if (previous.home === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous.home;
		if (previous.agent === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = previous.agent;
		if (previous.nonce === undefined) delete process.env.SUMMON_NONCE;
		else process.env.SUMMON_NONCE = previous.nonce;
		await fixture.dispose();
	});
}

/** A readiness notice whose hooks a test can replace one at a time. */
export function notice(nonce: string, overrides: Partial<WakePart> = {}): WakePart {
	return {
		target: { source: 'readiness', key: nonce, through: 0, ids: [] },
		text: 'notice',
		needed: () => Promise.resolve(true),
		acknowledged: () => Promise.resolve(false),
		mark: () => Promise.resolve(),
		...overrides,
	};
}

/** A live-PID owner with a valid v4 nonce: a held lock, not a malformed one awaiting recovery. */
export async function holdWatchdogLock(): Promise<{ path: string; nonce: string }> {
	const path = join(runtimePath('alpha'), 'response-watchdog.json.lock');
	const nonce = randomUUID();
	await mkdir(runtimePath('alpha'), { recursive: true });
	await writeFile(path, JSON.stringify({ pid: process.pid, nonce }));
	return { path, nonce };
}
