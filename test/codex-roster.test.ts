import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CodexTurnPhase } from '../src/codex-turn-rpc.ts';
import type { TeamAgent } from '../src/desktop/types.ts';

import { initializeActivity } from '../src/agent-activity.ts';
import * as models from '../src/provider-model-info.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let phase: CodexTurnPhase = 'idle';
let calls: readonly string[][] = [];
let delay: Promise<void> = Promise.resolve();
let release = () => {};
await mock.module('../src/codex-turn-rpc.ts', () => ({
	readCodexThreadStatuses: async (threads: readonly string[]) => {
		calls = [...calls, [...threads]];
		const value = phase;
		await delay;
		return new Map(threads.map((thread) => [thread, value]));
	},
}));
const { codexRosterTurns, codexTurn } = await import('../src/codex-turn.ts');
const { teamSnapshot } = await import('../src/desktop/team-snapshot.ts');
let fixture: Awaited<ReturnType<typeof mailHarness>>;
const priorHome = process.env.SUMMON_HOME;
let now = new Date().getTime();
let restoreClock = () => {};
let restoreModel = () => {};
const launch = { name: 'alpha', nonce: 'roster-launch' };
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	phase = 'idle';
	calls = [];
	delay = Promise.resolve();
	release = () => {};
	now = new Date().getTime();
	const clock = spyOn(Date, 'now').mockImplementation(() => now);
	restoreClock = () => clock.mockRestore();
	const model = spyOn(models, 'refreshModelInfo').mockResolvedValue(undefined);
	restoreModel = () => model.mockRestore();
});
afterEach(async () => {
	release();
	restoreModel();
	restoreClock();
	if (priorHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = priorHome;
	await fixture.dispose();
});
async function bind(name = launch.name, nonce = launch.nonce, thread = `${name}-thread`) {
	await initializeActivity(name, nonce, 'codex');
	await writeFile(join(fixture.records, `runtime/${name}/${nonce}.binding`), thread);
}
async function untilPhase(value: CodexTurnPhase, selected = [launch]) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const result = await codexRosterTurns(selected);
		if (result.get(selected[0]?.name ?? '') === value) return result;
		await Bun.sleep(10);
	}
	throw new Error(`Roster did not observe ${value}.`);
}

test('five owned Codex rows return while the one batched daemon read is still pending', async () => {
	const sessions = new Map<
		string,
		{
			agent: TeamAgent;
			launch: { nonce: string; since: string };
		}
	>();
	for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
		await writeFile(
			join(fixture.records, `${name}.json`),
			JSON.stringify(newRecord(name, fixture.root, 'codex')),
		);
		await bind(name);
		const agent: TeamAgent = {
			slug: name,
			name,
			provider: 'codex',
			cwd: fixture.root,
			status: 'running',
		};
		sessions.set(name, {
			agent,
			launch: { nonce: launch.nonce, since: new Date().toISOString() },
		});
	}
	delay = new Promise<void>((resolve) => {
		release = resolve;
	});
	const context = {
		sessions,
		reported: new Set<string>(),
		emit: () => {},
		startedAt: new Date().toISOString(),
		selected: 'alpha',
	};
	const started = performance.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const snapshot = await Promise.race([
			teamSnapshot(context),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('Roster awaited the blocked RPC.')),
					1000,
				);
			}),
		]);
		expect(snapshot.agents).toHaveLength(5);
		expect(snapshot.agents.every((agent) => agent.providerTurn === 'unknown')).toBe(true);
		await teamSnapshot(context);
		expect(calls).toEqual([
			['alpha-thread', 'beta-thread', 'gamma-thread', 'delta-thread', 'epsilon-thread'],
		]);
		console.log(
			JSON.stringify({
				fixture: 'five-Codex-roster',
				elapsedMs: performance.now() - started,
				rpcBatches: calls.length,
				rpcStillPending: true,
			}),
		);
	} finally {
		if (timer) clearTimeout(timer);
		release();
		await untilPhase('idle');
	}
});

test('loaded idle is cached for 15 s; expired evidence is unknown until refreshed', async () => {
	await bind();
	expect((await codexRosterTurns([launch])).get('alpha')).toBe('unknown');
	await untilPhase('idle');
	phase = 'busy';
	now += 14_999;
	expect((await codexRosterTurns([launch])).get('alpha')).toBe('idle');
	expect(calls).toHaveLength(1);
	now++;
	expect((await codexRosterTurns([launch])).get('alpha')).toBe('unknown');
	await untilPhase('busy');
	expect(calls).toHaveLength(2);
});

test('unknown failures are cached instead of retrying on every roster poll', async () => {
	await bind();
	phase = 'unknown';
	await codexRosterTurns([launch]);
	// A fresh direct read is a separate RPC; it also lets the pending roster write finish.
	await codexTurn('alpha', launch.nonce);
	await Bun.sleep(20);
	const count = calls.length;
	for (let poll = 0; poll < 4; poll++) await codexRosterTurns([launch]);
	expect(calls).toHaveLength(count);
	now += 15_000;
	await codexRosterTurns([launch]);
	expect(calls).toHaveLength(count + 1);
	await Bun.sleep(20);
});

test('fresh decision readers ignore cached idle', async () => {
	await bind();
	await untilPhase('idle');
	phase = 'busy';
	expect((await codexRosterTurns([launch])).get('alpha')).toBe('idle');
	expect(await codexTurn('alpha', launch.nonce)).toBe('busy');
});

test('a rebind or replacement launch cannot inherit cached idle', async () => {
	await bind();
	await untilPhase('idle');
	phase = 'busy';
	await bind('alpha', launch.nonce, 'replacement-thread');
	expect((await codexRosterTurns([launch])).get('alpha')).toBe('unknown');
	await untilPhase('busy');
	await bind('alpha', 'replacement-launch');
	expect((await codexRosterTurns([launch])).get('alpha')).toBe('unknown');
});

test('an in-flight old binding does not publish idle for its replacement', async () => {
	await bind();
	delay = new Promise<void>((resolve) => {
		release = resolve;
	});
	await codexRosterTurns([launch]);
	await bind('alpha', launch.nonce, 'replacement-thread');
	phase = 'busy';
	expect((await codexRosterTurns([launch])).get('alpha')).toBe('unknown');
	release();
	await untilPhase('busy');
	expect(calls).toEqual([['alpha-thread'], ['replacement-thread']]);
});

test('another store with the same member, nonce and thread cannot inherit idle', async () => {
	await bind();
	await untilPhase('idle');
	const other = await mailHarness();
	try {
		process.env.SUMMON_HOME = other.records;
		await initializeActivity('alpha', launch.nonce, 'codex');
		await writeFile(
			join(other.records, `runtime/alpha/${launch.nonce}.binding`),
			'alpha-thread',
		);
		phase = 'busy';
		expect((await codexRosterTurns([launch])).get('alpha')).toBe('unknown');
		await untilPhase('busy');
	} finally {
		process.env.SUMMON_HOME = fixture.records;
		await other.dispose();
	}
});

test('missing bindings do not query a daemon and a named caller cannot use a peer cache', async () => {
	expect((await codexRosterTurns([launch])).get('alpha')).toBe('unknown');
	expect(calls).toHaveLength(0);
	await bind('beta');
	await untilPhase('idle', [{ name: 'beta', nonce: launch.nonce }]);
	const priorAgent = process.env.SUMMON_AGENT;
	const priorNonce = process.env.SUMMON_NONCE;
	try {
		process.env.SUMMON_AGENT = 'alpha';
		process.env.SUMMON_NONCE = launch.nonce;
		expect((await codexRosterTurns([{ name: 'beta', nonce: launch.nonce }])).get('beta')).toBe(
			'unknown',
		);
		expect(calls).toHaveLength(1);
	} finally {
		if (priorAgent === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = priorAgent;
		if (priorNonce === undefined) delete process.env.SUMMON_NONCE;
		else process.env.SUMMON_NONCE = priorNonce;
	}
});
