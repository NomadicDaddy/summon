import { afterEach, beforeEach, expect, test } from 'bun:test';

import { ProcessTreeStopError } from '../src/desktop/pty-process.ts';
import { stopRestSession } from '../src/desktop/rest-stop.ts';
import { stopIfConfirmed } from '../src/desktop/stop-evidence.ts';
import { readRest, stopForRest } from '../src/rest.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { readyOwnedRest } from './fixtures/rest-turn.ts';
import { failingHarness, states } from './fixtures/stop-unverified-harness.ts';

/*
 * A Windows Stop whose taskkill reports a failure (bsa1 at 615d480, 2026-10-28: the root ended,
 * two descendants answered "operation not supported", and ConPTY reported the exit about 117 s
 * later). The operator's intent must survive until that exit, nothing may be terminated again,
 * and only the terminal's own exit may mark the session stopped. Window close, late exits and
 * the launch identity are in stop-unverified-close-race.test.ts.
 */
let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

const windows = test.skipIf(process.platform !== 'win32');

windows(
	'a failed taskkill keeps the operator stop until the terminal reports its exit',
	async () => {
		const h = failingHarness('gone');
		await h.team.start('alpha');
		const result = await stopIfConfirmed(h.team, 'alpha', true);
		expect(result).toMatchObject({ unverified: true, rootChecked: true });
		if (!('unverified' in result)) throw new Error('Expected an unverified stop.');
		expect(result.detail).toContain('Stop unverified; waiting for terminal exit');
		expect(result.detail).toContain('root process gone');
		const session = h.team.sessions.get('alpha');
		expect(session?.agent.status).toBe('running');
		expect(session?.stopRequested).toBe(true);
		expect(session?.agent.stopUnverified).toBe(true);
		const row = (await h.team.snapshot()).agents.find((agent) => agent.slug === 'alpha');
		expect(row?.stopUnverified).toBe(true);
		// The late exit is the operator's stop, not an unexpected end.
		h.exit('alpha');
		expect(session?.agent.status).toBe('stopped');
		expect(session?.agent.stopUnverified).toBeUndefined();
		const output = h.events.flatMap((event) =>
			event.type === 'output' && event.slug === 'alpha' ? [event.data] : [],
		);
		expect(output.join('')).toContain('[Session stopped]');
		expect(output.join('')).not.toContain('[Session ended');
		await h.team.shutdown();
		expect(await states('alpha')).toEqual([
			'started:operator',
			'stop-requested:operator',
			'stopped:operator',
		]);
	},
);

windows('a second Stop while unverified terminates nothing', async () => {
	const h = failingHarness('gone');
	await h.team.start('alpha');
	await stopIfConfirmed(h.team, 'alpha', true);
	const again = await stopIfConfirmed(h.team, 'alpha', true);
	expect(again).toMatchObject({ unverified: true, rootChecked: true });
	expect(h.terminated).toHaveLength(1);
	expect(h.rootReads).toHaveLength(1);
	h.exit('alpha');
	await h.team.shutdown();
});

windows('a root confirmed alive records stop-failed but still keeps the intent', async () => {
	const h = failingHarness('alive');
	await h.team.start('alpha');
	const result = await stopIfConfirmed(h.team, 'alpha', true);
	expect(result).toMatchObject({ unverified: true, rootChecked: true });
	expect(h.team.sessions.get('alpha')?.stopRequested).toBe(true);
	await stopIfConfirmed(h.team, 'alpha', true);
	expect(h.terminated).toHaveLength(1);
	h.exit('alpha');
	await h.team.shutdown();
	expect(await states('alpha')).toEqual([
		'started:operator',
		'stop-requested:operator',
		'stop-failed:operator',
		'stopped:operator',
	]);
});

windows('an unreadable root is reported as not checked, never as gone', async () => {
	const h = failingHarness('unknown');
	await h.team.start('alpha');
	const result = await stopIfConfirmed(h.team, 'alpha', true);
	expect(result).toMatchObject({ unverified: true, rootChecked: false });
	if (!('unverified' in result)) throw new Error('Expected an unverified stop.');
	expect(result.detail).toContain('root process unknown');
	h.exit('alpha');
	await h.team.shutdown();
});

windows('localized taskkill output does not change the outcome', async () => {
	const h = failingHarness(
		'gone',
		(pid) =>
			new ProcessTreeStopError(
				pid,
				128,
				null,
				'FEHLER: Der Prozess mit PID 7372 konnte nicht beendet werden.',
			),
	);
	await h.team.start('alpha');
	const result = await stopIfConfirmed(h.team, 'alpha', true);
	expect(result).toMatchObject({ unverified: true, rootChecked: true });
	h.exit('alpha');
	await h.team.shutdown();
});

windows('input is refused while a stop is unverified', async () => {
	const h = failingHarness('gone');
	await h.team.start('alpha');
	await stopIfConfirmed(h.team, 'alpha', true);
	const before = h.writes.length;
	await h.team.input('alpha', 'hello', true);
	expect(h.writes).toHaveLength(before);
	h.exit('alpha');
	await h.team.shutdown();
});

windows('a delegated rest stop that is unverified leaves rest uncertain, not stopped', async () => {
	const h = failingHarness('gone');
	try {
		const state = await readyOwnedRest(fixture, h);
		const failure: unknown = await stopForRest(
			'alpha',
			state.id,
			(nonce) => stopRestSession(h.team, 'alpha', nonce),
			'claude',
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((await readRest('alpha'))?.mode).toBe('uncertain');
		expect(h.team.sessions.get('alpha')?.stopRequested).toBe(true);
		h.exit('alpha');
		expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
	} finally {
		await h.team.shutdown();
	}
});

windows('a failure that is not taskkill still clears the intent and rejects', async () => {
	const h = failingHarness('gone', () => new Error('spawn taskkill.exe ENOENT'));
	await h.team.start('alpha');
	const failure: unknown = await stopIfConfirmed(h.team, 'alpha', true).catch(
		(error: unknown) => error,
	);
	expect(failure).toBeInstanceOf(Error);
	const session = h.team.sessions.get('alpha');
	expect(session?.stopRequested).toBe(false);
	expect(session?.agent.stopUnverified).toBeUndefined();
	expect(h.rootReads).toHaveLength(0);
	h.exit('alpha');
	await h.team.shutdown();
	expect(await states('alpha')).toEqual([
		'started:operator',
		'stop-requested:operator',
		'stop-failed:operator',
		'exited:unknown',
	]);
});
