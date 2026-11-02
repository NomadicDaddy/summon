import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';

import type { StopRoot, StopRootState } from '../src/desktop/stop-root.ts';

import { captureRoot } from '../src/desktop/owned-session-stop.ts';
import { stopIfConfirmed } from '../src/desktop/stop-evidence.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { failingHarness, states } from './fixtures/stop-unverified-harness.ts';

/*
 * The unverified Stop at its edges: window close while it is unverified, a terminal exit that
 * lands while the stop is still being recorded, and the launch identity its root check relies on.
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

windows('closing the window is refused while a stop is unverified', async () => {
	const h = failingHarness('gone');
	await h.team.start('alpha');
	await stopIfConfirmed(h.team, 'alpha', true);
	const closing: unknown = await h.team.shutdown().catch((error: unknown) => error);
	expect(closing).toBeInstanceOf(AggregateError);
	expect(h.terminated).toHaveLength(1);
	h.exit('alpha');
	h.team.closing = false;
	await h.team.shutdown();
});

windows('closing twice without Stop first refuses both and terminates once', async () => {
	// Morgan 40591cd8: window close is the first Stop, then a retried close, then the late exit.
	const h = failingHarness('gone');
	await h.team.start('alpha');
	for (let attempt = 0; attempt < 2; attempt++) {
		const closing: unknown = await h.team.shutdown().catch((error: unknown) => error);
		expect(closing).toBeInstanceOf(AggregateError);
		expect(h.team.sessions.get('alpha')?.agent.stopUnverified).toBe(true);
		h.team.closing = false;
	}
	expect(h.terminated).toHaveLength(1);
	h.exit('alpha');
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
	await h.team.shutdown();
	expect(await states('alpha')).toEqual([
		'started:operator',
		'stop-requested:window-close',
		'stopped:window-close',
	]);
});

/** Morgan 90ddfa0a: the terminal exits while the unverified stop is still being published. */
async function exitDuringPublish(root: StopRootState) {
	const h = failingHarness(root);
	await h.team.start('alpha');
	const held = Promise.withResolvers<undefined>();
	const reached = Promise.withResolvers<undefined>();
	const publish = spyOn(h.team, 'publish').mockImplementation(async () => {
		reached.resolve(undefined);
		await held.promise;
	});
	const pending = stopIfConfirmed(h.team, 'alpha', true);
	await reached.promise;
	h.exit('alpha');
	held.resolve(undefined);
	const result = await pending;
	publish.mockRestore();
	expect(result).toEqual({ stopped: true });
	expect(h.terminated).toHaveLength(1);
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
	expect(h.team.sessions.get('alpha')?.agent.stopUnverified).toBeUndefined();
	await h.team.shutdown();
	return states('alpha');
}

windows('an exit that lands while the stop is published answers stopped', async () => {
	expect(await exitDuringPublish('gone')).toEqual([
		'started:operator',
		'stop-requested:operator',
		'stopped:operator',
	]);
});

windows('an exit after a stop-failed write still answers stopped', async () => {
	expect(await exitDuringPublish('alive')).toEqual([
		'started:operator',
		'stop-requested:operator',
		'stop-failed:operator',
		'stopped:operator',
	]);
});

windows('a Team without a root reader reports the root as not checked', async () => {
	const h = failingHarness('gone');
	delete h.team.stopRoot;
	await h.team.start('alpha');
	const result = await stopIfConfirmed(h.team, 'alpha', true);
	expect(result).toMatchObject({ unverified: true, rootChecked: false });
	expect(h.rootReads).toHaveLength(0);
	h.exit('alpha');
	await h.team.shutdown();
});

test('the launch capture is asked for this exact member, nonce and start', async () => {
	const asked: unknown[] = [];
	const stopRoot: StopRoot = {
		capture: (pid, launch) => {
			asked.push({ pid, ...launch });
			return Promise.resolve(1234);
		},
		state: () => Promise.resolve('alive'),
	};
	const launch = { nonce: 'n-1', since: '2026-10-28T06:00:00.000Z' };
	expect(await captureRoot({ stopRoot }, 7, 'alpha', launch)).toBe(1234);
	expect(asked).toEqual([
		{ pid: 7, slug: 'alpha', nonce: 'n-1', since: Date.parse(launch.since) },
	]);
	// A reader failure or no reader records nothing, so the root later reads unknown.
	const failing: StopRoot = { ...stopRoot, capture: () => Promise.reject(new Error('read')) };
	expect(await captureRoot({ stopRoot: failing }, 7, 'alpha', launch)).toBeUndefined();
	expect(await captureRoot({}, 7, 'alpha', launch)).toBeUndefined();
});
