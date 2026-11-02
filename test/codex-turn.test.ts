import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let phase: 'busy' | 'idle' | 'unknown' = 'idle';
let queried: readonly string[] = [];
let duringRead = async () => {};
await mock.module('../src/codex-turn-rpc.ts', () => ({
	readCodexThreadStatuses: async (threads: readonly string[]) => {
		queried = threads;
		await duringRead();
		return new Map(threads.map((thread) => [thread, phase]));
	},
}));
const { codexTurn, codexTurns } = await import('../src/codex-turn.ts');
let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	phase = 'idle';
	queried = [];
	duringRead = async () => {};
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});
async function bind(name = 'alpha', nonce = 'current-launch', thread = 'owned-thread') {
	await initializeActivity(name, nonce, 'codex');
	await writeFile(join(fixture.records, `runtime/${name}/${nonce}.binding`), thread);
}

test.each(['busy', 'idle', 'unknown'] as const)(
	'current exact thread reports %s',
	async (value) => {
		await bind();
		phase = value;
		expect(await codexTurn('alpha', 'current-launch')).toBe(value);
		expect(queried).toEqual(['owned-thread']);
	},
);

test('self-reported idle without a current binding is unknown, not native idle', async () => {
	await initializeActivity('alpha', 'current-launch', 'codex');
	expect(await codexTurn('alpha', 'current-launch')).toBe('unknown');
	expect(queried).toEqual([]);
});

test('an old nonce or another provider never selects a thread', async () => {
	await bind();
	expect(await codexTurn('alpha', 'old-launch')).toBe('unknown');
	expect(queried).toEqual([]);
	await initializeActivity('alpha', 'current-launch', 'claude');
	expect(await codexTurn('alpha', 'current-launch')).toBe('unknown');
	expect(queried).toEqual([]);
});

test('relaunch during observation cannot inherit old idle', async () => {
	await bind();
	duringRead = () => initializeActivity('alpha', 'replacement-launch', 'codex');
	expect(await codexTurn('alpha', 'current-launch')).toBe('unknown');
});

test('clear/rebind during observation cannot inherit another thread idle', async () => {
	await bind();
	duringRead = () =>
		writeFile(join(fixture.records, 'runtime/alpha/current-launch.binding'), 'new-thread');
	expect(await codexTurn('alpha', 'current-launch')).toBe('unknown');
});

test('roster selections use one deduplicated batch of current bound threads', async () => {
	await bind();
	await bind('beta', 'second-launch', 'another-thread');
	const phases = await codexTurns([
		{ name: 'alpha', nonce: 'current-launch' },
		{ name: 'beta', nonce: 'second-launch' },
	]);
	expect(queried).toEqual(['owned-thread', 'another-thread']);
	expect([...phases.values()]).toEqual(['idle', 'idle']);
});

test('a named teammate cannot read a peer binding', async () => {
	await bind('beta');
	const priorAgent = process.env.SUMMON_AGENT;
	const priorNonce = process.env.SUMMON_NONCE;
	try {
		process.env.SUMMON_AGENT = 'alpha';
		process.env.SUMMON_NONCE = 'current-launch';
		expect(await codexTurn('beta', 'current-launch')).toBe('unknown');
		expect(queried).toEqual([]);
	} finally {
		if (priorAgent === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = priorAgent;
		if (priorNonce === undefined) delete process.env.SUMMON_NONCE;
		else process.env.SUMMON_NONCE = priorNonce;
	}
});
