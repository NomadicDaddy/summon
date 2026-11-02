import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Provider } from '../src/store.ts';

import { initializeActivity } from '../src/agent-activity.ts';
import { initializeClaudeTurn } from '../src/claude-turn-state.ts';
import { tryGracefulStop } from '../src/desktop/graceful-stop.ts';
import { Team, type TerminalProcess } from '../src/desktop/team.ts';
import { terminalDraft } from '../src/desktop/terminal-draft.ts';
import { initializeGrokTurn } from '../src/grok-turn-state.ts';
import { initializeKiloTurn } from '../src/kilo-turn-state.ts';
import { loadAgent, saveAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { observeFixtureClaudeIdle } from './fixtures/wake-team.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let fixtureTeam: Team | undefined;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixtureTeam = undefined;
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	try {
		await fixtureTeam?.shutdown();
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
	}
	await fixture.dispose();
});

async function harness(provider: Provider, graceful = true) {
	const record = await loadAgent('alpha');
	if (!record) throw new Error('Missing record');
	await saveAgent('alpha', { ...record, provider });
	const writes: string[] = [];
	let forced = 0;
	let ended: (event: { exitCode: number }) => void = () => {};
	const pty: TerminalProcess = {
		pid: 1,
		onData: () => ({ dispose: () => {} }),
		onExit: (listener) => {
			ended = listener;
			return { dispose: () => {} };
		},
		write: (text) => {
			writes.push(String(text));
			if (graceful && text === '\r' && writes.at(-2) === '/exit') ended({ exitCode: 0 });
		},
		resize: () => {},
		kill: () => {
			forced++;
			ended({ exitCode: 0 });
		},
	};
	const team = new Team(
		'bun',
		'cli.ts',
		() => {},
		() => pty,
		() => {
			pty.kill();
			return Promise.resolve();
		},
	);
	fixtureTeam = team;
	await team.start('alpha');
	const session = team.sessions.get('alpha');
	if (!session) throw new Error('Missing session');
	const { nonce } = session.launch;
	const runtime = join(fixture.records, 'runtime/alpha');
	await mkdir(runtime, { recursive: true });
	await initializeActivity('alpha', nonce);
	const activity = async (state: string, identity = nonce) =>
		writeFile(
			join(runtime, 'activity.json'),
			JSON.stringify({
				state,
				nonce: identity,
				workingOn: 'Ready',
				updatedAt: new Date().toISOString(),
			}),
		);
	await activity('idle');
	if (provider === 'claude') {
		await initializeClaudeTurn('alpha', nonce, 'thread', 'observer');
		await observeFixtureClaudeIdle('alpha', nonce);
	}
	if (provider === 'grok' || provider === 'kilo') {
		if (provider === 'grok') await initializeGrokTurn('alpha', nonce, 'thread');
		else await initializeKiloTurn('alpha', nonce, 'thread');
		const path = join(runtime, `${nonce}.${provider}-turn`);
		const turn = (await Bun.file(path).json()) as Record<string, unknown>;
		await writeFile(path, JSON.stringify({ ...turn, phase: 'idle' }));
	}
	return { team, session, writes, activity, runtime, forced: () => forced };
}

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const) {
	test(`${provider}: concurrent stops use the provider-specific termination path once`, async () => {
		const h = await harness(provider);
		await Promise.all([h.team.stop('alpha'), h.team.stop('alpha')]);
		const forceOnly = provider === 'codex' || provider === 'claude';
		expect(h.writes).toEqual(forceOnly ? [] : ['/exit', '\r']);
		expect(h.forced()).toBe(forceOnly ? 1 : 0);
		expect(h.session.agent.status).toBe('stopped');
	});
	test(`${provider}: known human draft uses existing forced stop without submitting text`, async () => {
		const h = await harness(provider);
		await h.team.input('alpha', 'unfinished human input');
		await h.team.stop('alpha');
		expect(h.writes).toEqual(['unfinished human input']);
		expect(h.forced()).toBe(1);
	});
}

test('Codex reported idle at an approval prompt never receives synthetic approval input', async () => {
	const h = await harness('codex');
	let approvalSubmitted = false;
	h.session.pty.write = (text) => {
		if (String(text).includes('\r')) approvalSubmitted = true;
		h.writes.push(String(text));
	};
	await h.team.stop('alpha');
	expect(h.writes).toEqual([]);
	expect(approvalSubmitted).toBe(false);
	expect(h.forced()).toBe(1);
});

test('Claude double Escape cannot turn an idle overlay into a synthetic stop submission', async () => {
	const h = await harness('claude');
	await h.team.input('alpha', '\u001b');
	await h.team.input('alpha', '\u001b');
	expect(terminalDraft(h.session.pty).draft).toBe(false);
	const humanWrites = [...h.writes];
	await h.team.stop('alpha');
	expect(h.writes).toEqual(humanWrites);
	expect(h.forced()).toBe(1);
});

for (const state of ['busy', 'needs-user']) {
	test(`${state} skips native exit`, async () => {
		const h = await harness('grok');
		await h.activity(state);
		await h.team.stop('alpha');
		expect(h.writes).toEqual([]);
		expect(h.forced()).toBe(1);
	});
}

test('stale launch activity cannot authorize native input', async () => {
	const h = await harness('grok');
	await h.activity('idle', 'old-launch');
	await h.team.stop('alpha');
	expect(h.writes).toEqual([]);
	expect(h.forced()).toBe(1);
});

test('missing native observation skips graceful exit despite reported idle', async () => {
	const h = await harness('grok');
	await writeFile(join(h.runtime, `${h.session.launch.nonce}.grok-turn`), '{}');
	await h.team.stop('alpha');
	expect(h.writes).toEqual([]);
	expect(h.forced()).toBe(1);
});

for (const provider of ['claude', 'grok', 'kilo'] as const) {
	test(`${provider}: native busy overrides reported idle`, async () => {
		const h = await harness(provider);
		const path = join(h.runtime, `${h.session.launch.nonce}.${provider}-turn`);
		const turn = (await Bun.file(path).json()) as Record<string, unknown>;
		await writeFile(path, JSON.stringify({ ...turn, phase: 'busy' }));
		await h.team.stop('alpha');
		expect(h.writes).toEqual([]);
		expect(h.forced()).toBe(1);
	});
}

test('a failed native write still terminates the requested session', async () => {
	const h = await harness('grok');
	h.session.pty.write = () => {
		throw new Error('Fixture write failure');
	};
	await h.team.stop('alpha');
	expect(h.forced()).toBe(1);
	expect(h.session.agent.status).toBe('stopped');
});

test('human input is blocked throughout stopping; rest and window close share the path', async () => {
	const h = await harness('grok');
	const stop = h.team.stop('alpha', 'rest-work');
	await h.team.input('alpha', 'must not enter composer');
	await stop;
	expect(h.writes).toEqual(['/exit', '\r']);
	expect(h.session.stopReason).toBe('rest-work');
	await h.team.start('alpha');
	await h.team.shutdown();
	expect(h.team.sessions.get('alpha')?.stopReason).toBe('window-close');
});

test('replacement session during submit delay receives no old Enter', async () => {
	const h = await harness('grok', false);
	let current = true;
	await tryGracefulStop(
		h.session,
		() => current,
		() => {
			current = false;
			return Promise.resolve();
		},
	);
	expect(h.writes).toEqual(['/exit']);
});

test('activity changing during submit delay prevents Enter', async () => {
	const h = await harness('grok', false);
	await tryGracefulStop(
		h.session,
		() => true,
		() => h.activity('busy'),
	);
	expect(h.writes).toEqual(['/exit']);
});

test('unresponsive native exit falls back after the grace period', async () => {
	const h = await harness('grok', false);
	const started = Date.now();
	await h.team.stop('alpha');
	expect(Date.now() - started).toBeGreaterThanOrEqual(5000);
	expect(h.writes).toEqual(['/exit', '\r']);
	expect(h.forced()).toBe(1);
}, 10000);
