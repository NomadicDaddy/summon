import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { StopOutcome } from '../src/desktop/owned-session-stop.ts';
import type { TeamEvent } from '../src/desktop/types.ts';

import { labels, offlineTitle } from '../src/desktop/hibernation-controls.ts';
import { Team, type TerminalProcess } from '../src/desktop/team.ts';
import { setHibernation } from '../src/hibernation.ts';
import { sendHuman } from '../src/local-room-access.ts';
import { acquireSessionLock, type SessionLock } from '../src/session-lock.ts';
import { loadAgent, saveAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
let lock: SessionLock | undefined;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	await lock?.release();
	lock = undefined;
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});
/**
 * @param failStop The fixture process refuses to be killed.
 * @param taskkill Terminate reports failure the way taskkill does when it exits non-zero: either
 * the process had already ended by then ('exited') or it is still running ('running').
 */
function harness(failStop = false, taskkill?: 'exited' | 'running') {
	const events: TeamEvent[] = [];
	const inputs: string[] = [];
	let launches = 0;
	const argumentsUsed: string[][] = [];
	const sizes: { cols: number | undefined; rows: number | undefined }[] = [];
	let exit: (event: { exitCode: number }) => void = () => {};
	const pty: TerminalProcess = {
		pid: 1,
		onData: () => ({ dispose: () => {} }),
		onExit: (listener) => {
			exit = listener;
			return { dispose: () => {} };
		},
		write: (text) => {
			inputs.push(String(text));
		},
		resize: () => {},
		kill: () => {
			if (failStop) throw new Error('Fixture stop failed');
			exit({ exitCode: 0 });
		},
	};
	const team = new Team(
		'bun',
		'cli.ts',
		(event) => {
			events.push(event);
		},
		(_file, args, options) => {
			launches++;
			sizes.push({ cols: options.cols, rows: options.rows });
			argumentsUsed.push(args);
			return pty;
		},
		(_pid, alreadyGone) => {
			if (taskkill === undefined) {
				pty.kill();
				return Promise.resolve();
			}
			if (taskkill === 'exited') exit({ exitCode: 1 });
			return alreadyGone()
				? Promise.resolve()
				: Promise.reject(new Error('Could not stop the session process tree'));
		},
	);
	return {
		team,
		inputs,
		events,
		argumentsUsed,
		sizes,
		launches: () => launches,
		exit: () => exit({ exitCode: 0 }),
	};
}
for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const) {
	test(`${provider} input forwards terminal replies and human frames unchanged`, async () => {
		const record = await loadAgent('alpha');
		if (!record) throw new Error('Missing fixture record.');
		record.provider = provider;
		await saveAgent('alpha', record);
		await mkdir(join(fixture.records, 'settings'), { recursive: true });
		await writeFile(
			join(fixture.records, 'settings/claude-delivery.json'),
			'{"version":1,"mode":"checkpoint"}',
		);
		const h = harness();
		try {
			await h.team.start('alpha');
			await h.team.input('alpha', '\u001b[?1;2c', false);
			await h.team.input('alpha', 'human text', true);
			await h.team.input('alpha', '\r', true);
			expect(h.inputs).toEqual(['\u001b[?1;2c', 'human text', '\r']);
		} finally {
			await h.team.shutdown();
		}
	});
}
test('hibernation retains an owned terminal, blocks input and skips @all with an awake positive control', async () => {
	const h = harness();
	await h.team.start('alpha');
	await h.team.hibernate('alpha', true);
	const alpha = (await h.team.snapshot()).agents.find((agent) => agent.slug === 'alpha');
	expect(alpha?.status).toBe('hibernated');
	expect(alpha?.ownedSession).toBe(true);
	expect(await h.team.input('alpha', 'do work').catch((error: unknown) => error)).toBeInstanceOf(
		Error,
	);
	await h.team.wakeMentions(await sendHuman('@all review'));
	expect(h.launches()).toBe(2);
	expect(
		h.events.some(
			(event) => event.type === 'error' && event.message.includes('alpha was not woken'),
		),
	).toBe(true);
	await h.team.hibernate('alpha', false);
	expect(h.launches()).toBe(2);
	await h.team.input('alpha', 'resumed');
	expect(h.inputs).toEqual(['resumed']);
	await setHibernation('beta', true);
	await h.team.start('beta');
	expect(h.launches()).toBe(2);
});

test('operator Stop and shutdown record intent before the exit callback; resume clears it', async () => {
	const h = harness();
	await h.team.start('alpha');
	await h.team.stop('alpha');
	const stopped = (await h.team.snapshot()).agents.find((agent) => agent.slug === 'alpha');
	expect(stopped?.status).toBe('stopped');
	expect(stopped?.ownedSession).toBe(false);
	expect(labels.stopped).toBe('Stopped by operator');
	expect(offlineTitle({ status: 'stopped', exitCode: 0 })).toBe('Stopped by the operator');
	expect(
		h.events.filter(
			(event) => event.type === 'output' && event.data.includes('[Session stopped]'),
		),
	).toHaveLength(1);
	h.exit();
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
	await h.team.start('alpha');
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('running');
	h.exit();
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('exited');
	expect(offlineTitle({ status: 'exited', exitCode: 0 })).toContain('nobody stopped it');
	await h.team.start('alpha');
	await h.team.shutdown();
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
});

test('a failed stop leaves a running session and does not mislabel its later exit', async () => {
	const h = harness(true);
	await h.team.start('alpha');
	expect(await h.team.stop('alpha').catch((error: unknown) => String(error))).toContain(
		'Fixture stop failed',
	);
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('running');
	h.exit();
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('exited');
});

// Only Windows stops through terminate; elsewhere Team.stop kills the pty directly.
test.skipIf(process.platform !== 'win32')(
	'Team.stop resolves when terminate fails after the process is already gone',
	async () => {
		// taskkill can exit non-zero because the process ended first; the stop still succeeded.
		const gone = harness(false, 'exited');
		await gone.team.start('alpha');
		await gone.team.stop('alpha');
		expect(gone.team.sessions.get('alpha')?.agent.status).toBe('stopped');
		// Control: the same failure while the process is still running is a failed stop.
		const alive = harness(false, 'running');
		await alive.team.start('alpha');
		expect(await alive.team.stop('alpha').catch((error: unknown) => String(error))).toContain(
			'Could not stop the session process tree',
		);
		expect(alive.team.sessions.get('alpha')?.agent.status).toBe('running');
		alive.exit();
	},
);

test('team shutdown waits for a delayed peer stop after an earlier stop fails', async () => {
	const h = harness();
	await h.team.start('alpha');
	await h.team.start('beta');
	const delayed = Promise.withResolvers<StopOutcome>();
	const stop = spyOn(h.team, 'stop').mockImplementation((slug) =>
		slug === 'alpha' ? Promise.reject(new Error('Fixture failure')) : delayed.promise,
	);
	let settled = false;
	const closing = h.team.shutdown().catch((error: unknown) => {
		settled = true;
		return error;
	});
	await Promise.resolve();
	await Promise.resolve();
	expect(settled).toBe(false);
	delayed.resolve({ verified: true });
	expect(await closing).toBeInstanceOf(AggregateError);
	expect(settled).toBe(true);
	stop.mockRestore();
});
test('invalid records and activity do not blank the roster or repeat errors', async () => {
	const h = harness();
	await writeFile(join(fixture.records, 'broken.json'), '{');
	await mkdir(join(fixture.records, 'runtime/alpha'), { recursive: true });
	await writeFile(join(fixture.records, 'runtime/alpha/activity.json'), '{');
	const snapshot = await h.team.snapshot();
	expect(snapshot.agents.map((agent) => agent.slug)).toContain('beta');
	expect(snapshot.agents.map((agent) => agent.slug)).not.toContain('alpha');
	expect(h.events.filter((event) => event.type === 'error')).toHaveLength(2);
	await h.team.snapshot();
	expect(h.events.filter((event) => event.type === 'error')).toHaveLength(2);
});

test('concurrent starts focus one owned terminal and an ended session can resume', async () => {
	const h = harness();
	await Promise.all([h.team.start('alpha'), h.team.start('alpha')]);
	expect(h.launches()).toBe(1);
	expect(h.argumentsUsed[0]).toContain('--claude-mail-channel');
	await h.team.start('alpha');
	expect(h.launches()).toBe(1);
	await h.team.input('alpha', 'hello');
	await h.team.input('beta', 'not owned');
	expect(h.inputs).toEqual(['hello']);
	expect(
		await h.team.input('alpha', 'x'.repeat(65537)).catch((error: unknown) => error),
	).toBeInstanceOf(Error);
	h.exit();
	await h.team.start('alpha');
	expect(h.launches()).toBe(2);
	h.exit();
	await h.team.shutdown();
	expect(await h.team.start('beta').catch((error: unknown) => String(error))).toContain(
		'shutting down',
	);
});
test('externally locked sessions are displayed but never adopted, launched, or stopped', async () => {
	lock = await acquireSessionLock('alpha');
	const h = harness();
	await h.team.start('alpha');
	expect(h.launches()).toBe(0);
	// The lock's owner is this test process, not a session host for alpha, so presence cannot verify
	// it: the row reads unknown, which is shown and never startable, rather than online elsewhere.
	expect((await h.team.snapshot()).agents.find((agent) => agent.slug === 'alpha')?.status).toBe(
		'unknown',
	);
	await h.team.stop('alpha');
	await h.team.shutdown();
	expect(h.team.sessions.size).toBe(0);
	expect(await acquireSessionLock('alpha')).toBeUndefined();
	await lock?.release();
	lock = undefined;
	expect((await h.team.snapshot()).agents.find((agent) => agent.slug === 'alpha')?.status).toBe(
		'offline',
	);
});

test('resume resets the display and starts at the last measured terminal size', async () => {
	const h = harness();
	await h.team.start('alpha');
	h.team.resize('alpha', 160, 55);
	h.exit();
	await h.team.start('alpha');
	expect(h.sizes[1]).toEqual({ cols: 160, rows: 55 });
	expect(h.events.filter((event) => event.type === 'reset')).toHaveLength(2);
	h.exit();
	await h.team.shutdown();
});
