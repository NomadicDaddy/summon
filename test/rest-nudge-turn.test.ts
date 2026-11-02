import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Provider } from '../src/store.ts';

import { initializeClaudeTurn } from '../src/claude-turn-state.ts';
import { HELD_RECHECK_MS, nudgeRest } from '../src/desktop/rest-nudge.ts';
import { Team, type TerminalProcess } from '../src/desktop/team.ts';
import { initializeGrokTurn } from '../src/grok-turn-state.ts';
import { initializeKiloTurn } from '../src/kilo-turn-state.ts';
import { pendingMessages } from '../src/mailbox.ts';
import { loadAgent, saveAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { observeFixtureClaudeIdle } from './fixtures/wake-team.ts';

// tool-aware-idle-nudge: a self-reported idle is only a claim. The nudge also needs this launch's
// identity and turn evidence that isn't busy or unreadable. Codex's evidence is its bound
// thread's daemon status, mocked here per test; the runner isolates this file's module mock.
let codexPhase: 'busy' | 'idle' | 'unknown' = 'unknown';
let codexReads = 0;
await mock.module('../src/codex-turn-rpc.ts', () => ({
	readCodexThreadStatuses: (threads: readonly string[]) => {
		codexReads++;
		return Promise.resolve(new Map(threads.map((thread) => [thread, codexPhase])));
	},
}));
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

const later = () => Date.now() + 11 * 60000;
/** Past the back-off that follows busy or unknown evidence. */
const afterHold = (from: number) => from + HELD_RECHECK_MS + 1;

async function harness(provider: Provider) {
	const record = await loadAgent('alpha');
	if (!record) throw new Error('Missing record');
	await saveAgent('alpha', { ...record, provider });
	const pty: TerminalProcess = {
		pid: 1,
		onData: () => ({ dispose: () => {} }),
		onExit: () => ({ dispose: () => {} }),
		write: () => {},
		resize: () => {},
		kill: () => {},
	};
	const team = new Team(
		'bun',
		'cli.ts',
		() => {},
		() => pty,
	);
	await team.start('alpha');
	const session = team.sessions.get('alpha');
	if (!session) throw new Error('Missing session');
	const { nonce } = session.launch;
	const runtime = join(fixture.records, 'runtime/alpha');
	await mkdir(runtime, { recursive: true });
	const activity = (identity = nonce) =>
		writeFile(
			join(runtime, 'activity.json'),
			JSON.stringify({
				state: 'idle',
				nonce: identity,
				workingOn: 'Ready',
				updatedAt: new Date().toISOString(),
			}),
		);
	await activity();
	const turnPath = join(runtime, `${nonce}.${provider}-turn`);
	if (provider === 'claude') {
		await initializeClaudeTurn('alpha', nonce, 'thread', 'observer');
		await observeFixtureClaudeIdle('alpha', nonce);
	}
	if (provider === 'grok' || provider === 'kilo') {
		if (provider === 'grok') await initializeGrokTurn('alpha', nonce, 'thread');
		else await initializeKiloTurn('alpha', nonce, 'thread');
		const turn = (await Bun.file(turnPath).json()) as Record<string, unknown>;
		await writeFile(turnPath, JSON.stringify({ ...turn, phase: 'idle' }));
	}
	const phase = async (value: string) => {
		const turn = (await Bun.file(turnPath).json()) as Record<string, unknown>;
		await writeFile(turnPath, JSON.stringify({ ...turn, phase: value }));
	};
	return { team, activity, phase, turnPath, runtime, nonce };
}

const nudges = async () => (await pendingMessages('alpha')).length;

for (const provider of ['claude', 'grok', 'kilo'] as const) {
	test(`${provider}: observed idle is nudged once; a busy turn under a stale idle status is not`, async () => {
		const h = await harness(provider);
		const start = later();
		await h.phase('busy');
		await nudgeRest(h.team, 'alpha', start);
		expect(await nudges()).toBe(0);
		// Positive control: the same seat once the turn reads idle again, after the back-off.
		await h.phase('idle');
		await nudgeRest(h.team, 'alpha', afterHold(start));
		await nudgeRest(h.team, 'alpha', afterHold(start) + 2000);
		expect(await nudges()).toBe(1);
	});

	test(`${provider}: unreadable turn evidence is unknown, never idle by absence`, async () => {
		const h = await harness(provider);
		await writeFile(h.turnPath, '{not json');
		await nudgeRest(h.team, 'alpha', later());
		expect(await nudges()).toBe(0);
	});

	test(`${provider}: missing turn evidence is unknown, held, and leaves the episode unasked`, async () => {
		const h = await harness(provider);
		const evidence = await readFile(h.turnPath, 'utf8');
		await rm(h.turnPath);
		const start = later();
		await nudgeRest(h.team, 'alpha', start);
		expect(await nudges()).toBe(0);
		expect(existsSync(join(h.runtime, 'rest-nudge'))).toBe(false);
		// Held: the evidence returning idle inside the back-off doesn't ask yet.
		await writeFile(h.turnPath, evidence);
		await nudgeRest(h.team, 'alpha', start + 2000);
		expect(await nudges()).toBe(0);
		// Positive control: the same episode once the back-off ends.
		await nudgeRest(h.team, 'alpha', afterHold(start));
		expect(await nudges()).toBe(1);
	});
}

test('activity from another launch says nothing about this one', async () => {
	const h = await harness('claude');
	await h.activity('previous-launch');
	await nudgeRest(h.team, 'alpha', later());
	expect(await nudges()).toBe(0);
	await h.activity();
	await nudgeRest(h.team, 'alpha', later());
	expect(await nudges()).toBe(1);
});

test("codex follows its bound thread's daemon status: busy, unknown and unbound hold the question", async () => {
	const h = await harness('codex');
	let clock = later();
	// No binding yet: the daemon can't be asked about this launch, so the evidence is unknown.
	codexPhase = 'idle';
	await nudgeRest(h.team, 'alpha', clock);
	expect(await nudges()).toBe(0);
	await writeFile(join(h.runtime, `${h.nonce}.binding`), 'fixture-codex-thread');
	for (const phase of ['busy', 'unknown'] as const) {
		codexPhase = phase;
		clock = afterHold(clock);
		await nudgeRest(h.team, 'alpha', clock);
		expect([phase, await nudges()]).toEqual([phase, 0]);
	}
	// Positive control: the bound thread reads loaded idle.
	codexPhase = 'idle';
	clock = afterHold(clock);
	await nudgeRest(h.team, 'alpha', clock);
	await nudgeRest(h.team, 'alpha', clock + 2000);
	expect(await nudges()).toBe(1);
});

test('after busy or unknown evidence, 2 s ticks read the daemon once per back-off window', async () => {
	const h = await harness('codex');
	await writeFile(join(h.runtime, `${h.nonce}.binding`), 'fixture-codex-thread');
	codexPhase = 'unknown';
	codexReads = 0;
	const start = later();
	// Thirty ticks two seconds apart: one minute of an idle, unobserved Codex seat.
	for (let tick = 0; tick < 30; tick++) await nudgeRest(h.team, 'alpha', start + tick * 2000);
	expect(codexReads).toBe(1);
	await nudgeRest(h.team, 'alpha', afterHold(start));
	expect(codexReads).toBe(2);
	// A new idle episode reads at once rather than inheriting the old one's back-off.
	await h.activity();
	codexPhase = 'idle';
	await nudgeRest(h.team, 'alpha', afterHold(start) + 2000);
	expect(codexReads).toBe(3);
	expect(await nudges()).toBe(1);
});
