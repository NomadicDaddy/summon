import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { StopResult, TeamAgent, TeamEvent } from '../src/desktop/types.ts';

import { initializeActivity } from '../src/agent-activity.ts';
import { initializeClaudeTurn, observeClaudeTurn } from '../src/claude-turn-state.ts';
import { stopNeedsConfirm, stopWithConfirm } from '../src/desktop/stop-confirm.ts';
import { teamSnapshot } from '../src/desktop/team-snapshot.ts';
import * as models from '../src/provider-model-info.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

/*
 * remediation-20261021-stop-confirms-on-native-busy. On installed 0.30.1 a Claude session whose
 * own turn record said busy, while its self-reported activity.json said idle, was ended by one
 * Stop press with no confirmation. Stop now asks on the provider's word as well.
 */
const base: TeamAgent = {
	slug: 'alpha',
	name: 'Alpha',
	provider: 'claude',
	cwd: '.',
	status: 'running',
};

describe('stopNeedsConfirm', () => {
	test('asks when the provider reports a turn the teammate did not', () => {
		expect(stopNeedsConfirm({ ...base, activity: 'idle', providerTurn: 'busy' })).toBe(true);
		expect(stopNeedsConfirm({ ...base, activity: 'idle', providerTurn: 'unknown' })).toBe(true);
	});
	test('still asks on the self-reported busy or needs-user status', () => {
		expect(stopNeedsConfirm({ ...base, activity: 'busy' })).toBe(true);
		expect(stopNeedsConfirm({ ...base, activity: 'needs-user' })).toBe(true);
	});
	test('asks when a running session could not be observed', () => {
		expect(stopNeedsConfirm({ ...base, observationUnavailable: true })).toBe(true);
	});
	test('stops at once with no sign of work', () => {
		expect(stopNeedsConfirm({ ...base, activity: 'idle' })).toBe(false);
		expect(stopNeedsConfirm({ ...base })).toBe(false);
	});
});

describe('stopWithConfirm', () => {
	const busy: TeamAgent = { ...base, activity: 'idle', providerTurn: 'busy' };
	const question = 'Stop Alpha? Unsaved work in its session will be terminated.';
	/** A team:stop stand-in that records each call and answers what the main process found. */
	function mainProcess(working: boolean) {
		const calls: boolean[] = [];
		const stop = (confirmed: boolean): Promise<StopResult> => {
			calls.push(confirmed);
			return Promise.resolve(
				working && !confirmed ? { needsConfirm: true } : { stopped: true },
			);
		};
		return { calls, stop };
	}
	test('Cancel keeps the session', async () => {
		const asked: string[] = [];
		const main = mainProcess(true);
		await stopWithConfirm(busy, (message) => (asked.push(message), false), main.stop);
		expect(asked).toEqual([question]);
		expect(main.calls).toEqual([]);
	});
	test('accepting the question sends a confirmed stop', async () => {
		const main = mainProcess(true);
		await stopWithConfirm(busy, () => true, main.stop);
		expect(main.calls).toEqual([true]);
	});
	test('a session with no sign of work stops without a question', async () => {
		let asked = false;
		const main = mainProcess(false);
		const ask = () => ((asked = true), false);
		await stopWithConfirm({ ...base, activity: 'idle' }, ask, main.stop);
		expect(asked).toBe(false);
		expect(main.calls).toEqual([false]);
	});
	// remediation-20261023-stop-decides-on-stale-snapshot: the row says idle, the main process
	// finds a turn that began after the row was published.
	test('a refusal from the main process asks, then retries confirmed', async () => {
		const asked: string[] = [];
		const main = mainProcess(true);
		const accept = (message: string) => (asked.push(message), true);
		await stopWithConfirm({ ...base, activity: 'idle' }, accept, main.stop);
		expect(asked).toEqual([question]);
		expect(main.calls).toEqual([false, true]);
	});
	test('Cancel on that late question sends nothing more', async () => {
		const main = mainProcess(true);
		await stopWithConfirm({ ...base, activity: 'idle' }, () => false, main.stop);
		expect(main.calls).toEqual([false]);
	});
	test('Cancel answers nothing', async () => {
		const main = mainProcess(true);
		expect(await stopWithConfirm(busy, () => false, main.stop)).toBeUndefined();
	});
});

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const oldHome = process.env.SUMMON_HOME;
const nonce = 'stop-confirm-launch';
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	await fixture.dispose();
});

test('the owned snapshot carries the provider turn, and only while it is not idle', async () => {
	const model = spyOn(models, 'refreshModelInfo').mockResolvedValue(undefined);
	const agent: TeamAgent = { ...base, cwd: fixture.root };
	const session = { agent, launch: { nonce, since: new Date().toISOString() } };
	const context = {
		sessions: new Map([['alpha', session]]),
		reported: new Set<string>(),
		emit: () => {},
		startedAt: new Date().toISOString(),
		selected: 'alpha',
	};
	const row = async () =>
		(await teamSnapshot(context)).agents.find((value) => value.slug === 'alpha');
	let sequence = 0;
	const event = async (kind: 'attach' | 'idle' | 'start' | 'complete') =>
		observeClaudeTurn('alpha', nonce, 'observer', {
			session: 'thread',
			epoch: 1,
			sequence: ++sequence,
			kind,
			turn: kind === 'start' || kind === 'complete' ? 'turn-1' : null,
			draft: false,
			completed: kind === 'complete',
		});
	try {
		await initializeActivity('alpha', nonce, 'claude');
		await initializeClaudeTurn('alpha', nonce, 'thread', 'observer');
		await event('attach');
		expect((await row())?.providerTurn).toBe('unknown');
		await event('idle');
		expect((await row())?.providerTurn).toBeUndefined();
		await event('start');
		const busy = await row();
		expect(busy?.providerTurn).toBe('busy');
		// The defect: the self-reported status stays idle through the turn.
		expect(busy?.activity).toBe('idle');
		if (!busy) throw new Error('Missing owned snapshot.');
		expect(stopNeedsConfirm(busy)).toBe(true);
		await event('complete');
		const done = await row();
		expect(done?.providerTurn).toBeUndefined();
		if (!done) throw new Error('Missing owned snapshot.');
		expect(stopNeedsConfirm(done)).toBe(false);
		// A row this window does not own carries no provider turn at all.
		context.sessions.clear();
		expect((await row())?.providerTurn).toBeUndefined();
	} finally {
		model.mockRestore();
	}
});

test('an unreadable turn file keeps the row whole and makes Stop ask', async () => {
	const model = spyOn(models, 'refreshModelInfo').mockResolvedValue(undefined);
	// beta is registered by the harness; the owned session says Kilo, and the snapshot reads the
	// turn record for the session's provider.
	const agent: TeamAgent = {
		...base,
		slug: 'beta',
		name: 'Beta',
		provider: 'kilo',
		cwd: fixture.root,
	};
	const context = {
		sessions: new Map([
			['beta', { agent, launch: { nonce, since: new Date().toISOString() } }],
		]),
		reported: new Set<string>(),
		emit: () => {},
		startedAt: new Date().toISOString(),
		selected: 'beta',
	};
	try {
		await initializeActivity('beta', nonce, 'kilo');
		await Bun.write(join(fixture.records, `runtime/beta/${nonce}.kilo-turn`), '{');
		const value = (await teamSnapshot(context)).agents.find((item) => item.slug === 'beta');
		if (!value) throw new Error('Missing owned snapshot.');
		expect(value.providerTurn).toBe('unknown');
		// The normal owned row, not the degraded "cannot load" row the per-agent catch draws.
		expect(value.observationUnavailable).toBeUndefined();
		expect(value.status).toBe('running');
		expect(stopNeedsConfirm(value)).toBe(true);
	} finally {
		model.mockRestore();
	}
});

test('an unreadable Claude turn file keeps the row whole too', async () => {
	const model = spyOn(models, 'refreshModelInfo').mockResolvedValue(undefined);
	// Claude's record is read twice, for the compaction mark and for Stop; neither read may turn
	// the row into the degraded "cannot load" row.
	const agent: TeamAgent = { ...base, cwd: fixture.root };
	const events: TeamEvent[] = [];
	const context = {
		sessions: new Map([
			['alpha', { agent, launch: { nonce, since: new Date().toISOString() } }],
		]),
		reported: new Set<string>(),
		emit: (event: TeamEvent) => events.push(event),
		startedAt: new Date().toISOString(),
		selected: 'alpha',
	};
	const faults = () => events.filter((event) => event.type === 'error');
	try {
		await initializeActivity('alpha', nonce, 'claude');
		await Bun.write(join(fixture.records, `runtime/alpha/${nonce}.claude-turn`), '{');
		const value = (await teamSnapshot(context)).agents.find((item) => item.slug === 'alpha');
		if (!value) throw new Error('Missing owned snapshot.');
		expect(value.providerTurn).toBe('unknown');
		expect(value.observationUnavailable).toBeUndefined();
		expect(value.nativeCompacting).toBeUndefined();
		expect(value.status).toBe('running');
		expect(stopNeedsConfirm(value)).toBe(true);
		// The fault is reported once, not on every snapshot, and again after a clean read.
		expect(faults()).toMatchObject([{ source: 'claude-turn', slug: 'alpha' }]);
		await teamSnapshot(context);
		expect(faults()).toHaveLength(1);
		await rm(join(fixture.records, `runtime/alpha/${nonce}.claude-turn`));
		await initializeClaudeTurn('alpha', nonce, 'thread', 'observer');
		await teamSnapshot(context);
		await Bun.write(join(fixture.records, `runtime/alpha/${nonce}.claude-turn`), '{');
		await teamSnapshot(context);
		expect(faults()).toHaveLength(2);
	} finally {
		model.mockRestore();
	}
});

test('a turn record left by an earlier launch never asks for this one', async () => {
	const model = spyOn(models, 'refreshModelInfo').mockResolvedValue(undefined);
	const agent: TeamAgent = { ...base, cwd: fixture.root };
	const current = 'stop-confirm-current';
	const context = {
		sessions: new Map([
			['alpha', { agent, launch: { nonce: current, since: new Date().toISOString() } }],
		]),
		reported: new Set<string>(),
		emit: () => {},
		startedAt: new Date().toISOString(),
		selected: 'alpha',
	};
	try {
		// The earlier launch's record is mid-turn; this launch has no record yet.
		await initializeClaudeTurn('alpha', nonce, 'thread', 'observer');
		await observeClaudeTurn('alpha', nonce, 'observer', {
			session: 'thread',
			epoch: 1,
			sequence: 1,
			kind: 'start',
			turn: 'turn-1',
			draft: false,
			completed: false,
		});
		await initializeActivity('alpha', current, 'claude');
		const value = (await teamSnapshot(context)).agents.find((item) => item.slug === 'alpha');
		if (!value) throw new Error('Missing owned snapshot.');
		expect(value.providerTurn).toBeUndefined();
		expect(stopNeedsConfirm(value)).toBe(false);
	} finally {
		model.mockRestore();
	}
});
