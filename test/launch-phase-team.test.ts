import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TeamEvent } from '../src/desktop/types.ts';

import { initializeActivity, readActivity } from '../src/agent-activity.ts';
import { runtimeFaultDelivery } from '../src/desktop/runtime-fault-delivery.ts';
import { Team, type TerminalProcess } from '../src/desktop/team.ts';
import { stopTerminalReceivers, syncTerminalReceivers } from '../src/desktop/terminal-receivers.ts';
import {
	initializeKiloTurn,
	kiloStartupSettled,
	kiloStartupSubmitting,
	observeKiloTurn,
} from '../src/kilo-turn-state.ts';
import { launchReady, providerStarting, providerUp } from '../src/launch-phase.ts';
import { saveDelivery } from '../src/mail-session.ts';
import * as providerModels from '../src/provider-model-info.ts';
import { readRuntimeFaults } from '../src/runtime-faults.ts';
import { newRecord, rememberSession, saveAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { waitForNotice } from './fixtures/wake-team.ts';

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

function harness() {
	const events: TeamEvent[] = [],
		args: string[][] = [],
		inputs: string[] = [];
	const exits: (() => void)[] = [];
	const fault = runtimeFaultDelivery(
		() => new Date().toISOString(),
		(event) => events.push(event),
	);
	const team = new Team(
		'bun',
		'cli.ts',
		fault.send,
		(_file, command) => {
			args.push(command);
			let end = (): void => {};
			const pty: TerminalProcess = {
				pid: process.pid,
				onData: () => ({ dispose: () => {} }),
				onExit: (listener) => {
					end = () => {
						listener({ exitCode: 1 });
					};
					return { dispose: () => {} };
				},
				write: (text) => inputs.push(String(text)),
				resize: () => {},
				kill: () => end(),
			};
			exits.push(() => end());
			return pty;
		},
		() => {
			exits.at(-1)?.();
			return Promise.resolve();
		},
	);
	return { team, events, args, inputs, exits, fault };
}
async function member(team: Team) {
	return (await team.snapshot()).agents.find((agent) => agent.slug === 'alpha');
}
async function phaseEnded(team: Team) {
	for (let i = 0; i < 100; i++) {
		const current = await member(team);
		if (current?.launchEnded) return current;
		await Bun.sleep(10);
	}
	throw new Error('Exited phase was not retained.');
}

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const) {
	test(`${provider} owned spawn masks old status and resume gets a new identity`, async () => {
		await saveAgent('alpha', newRecord('alpha', fixture.root, provider));
		await initializeActivity('alpha', 'old-launch');
		const old = await readActivity('alpha');
		await writeFile(
			join(fixture.records, 'runtime/alpha/activity.json'),
			JSON.stringify({ ...old, state: 'busy', workingOn: 'Old task' }),
		);
		const h = harness();
		await h.team.start('alpha', false);
		const session = h.team.sessions.get('alpha');
		if (!session) throw new Error('Missing owned session.');
		expect(h.args[0]?.[h.args[0].indexOf('--launch-nonce') + 1]).toBe(session.launch.nonce);
		expect(await member(h.team)).toMatchObject({
			launch: { phase: 'connecting' },
			activity: 'idle',
			workingOn: '',
			status: 'running',
		});
		await initializeActivity('alpha', session.launch.nonce, provider);
		await launchReady('alpha', session.launch.nonce);
		expect((await member(h.team))?.launch?.phase).toBe('startup');
		const result = await fixture.run(['--status', 'idle', 'Ready'], 'alpha', {
			SUMMON_NONCE: session.launch.nonce,
		});
		expect(result.code).toBe(0);
		expect((await member(h.team))?.launch).toBeUndefined();
		h.exits[0]?.();
		await Bun.sleep(30);
		expect((await member(h.team))?.launchEnded).toBeUndefined();
		await h.team.start('alpha', false);
		expect(h.team.sessions.get('alpha')?.launch.nonce).not.toBe(session.launch.nonce);
		expect((await member(h.team))?.launch?.phase).toBe('connecting');
		// A delayed callback from the old child cannot end or fault the replacement.
		h.exits[0]?.();
		expect((await member(h.team))?.status).toBe('running');
		await h.team.stop('alpha');
		await h.fault.flush();
		expect((await readRuntimeFaults({ limit: 10 })).entries).toEqual([]);
	});
}

test('unexpected exit retains the actual phase in the row and runtime fault journal', async () => {
	const h = harness();
	await h.team.start('alpha', false);
	const launch = h.team.sessions.get('alpha')?.launch;
	if (!launch) throw new Error('Missing launch.');
	await initializeActivity('alpha', launch.nonce, 'claude');
	await providerUp('alpha', launch.nonce, 'claude', 'claude-mcp-initialized');
	h.exits[0]?.();
	expect((await phaseEnded(h.team)).launchEnded).toMatchObject({ phase: 'logging-in' });
	await h.fault.flush();
	expect((await readRuntimeFaults({ limit: 10 })).entries).toMatchObject([
		{
			member: 'alpha',
			source: 'launch',
			text: 'Session ended during logging-in before reporting its first status.',
		},
	]);
});

test('Grok snapshot consumes exact saved-session metadata only while the child runs', async () => {
	const record = newRecord('alpha', fixture.root, 'grok');
	rememberSession(record, 'grok-owned');
	await saveAgent('alpha', record);
	const h = harness();
	await h.team.start('alpha', false);
	const launch = h.team.sessions.get('alpha')?.launch;
	if (!launch) throw new Error('Missing launch.');
	await initializeActivity('alpha', launch.nonce, 'grok');
	await providerStarting('alpha', launch.nonce, 'grok-owned');
	await Bun.sleep(5);
	const path = join(
		fixture.root,
		'.grok/sessions',
		encodeURIComponent(fixture.root),
		'grok-owned',
	);
	await mkdir(path, { recursive: true });
	await writeFile(
		join(path, 'summary.json'),
		JSON.stringify({ current_model_id: 'fixture-model' }),
	);
	const info = await providerModels.readProviderModel(record, fixture.root);
	const read = spyOn(providerModels, 'refreshModelInfo').mockResolvedValue(info);
	try {
		expect((await member(h.team))?.launch).toMatchObject({
			phase: 'logging-in',
			evidence: 'grok-session-metadata',
		});
		await initializeActivity('alpha', launch.nonce, 'grok');
		await providerStarting('alpha', launch.nonce, 'grok-owned');
		h.exits[0]?.();
		await phaseEnded(h.team);
		expect((await readActivity('alpha'))?.launch?.phase).toBe('connecting');
	} finally {
		read.mockRestore();
		await h.fault.flush();
	}
});

test('Kilo Connecting does not block readiness, which waits only for the startup turn', async () => {
	await saveAgent('alpha', newRecord('alpha', fixture.root, 'kilo'));
	const h = harness();
	await h.team.start('alpha', false);
	const launch = h.team.sessions.get('alpha')?.launch;
	if (!launch) throw new Error('Missing launch.');
	await initializeActivity('alpha', launch.nonce, 'kilo');
	await initializeKiloTurn('alpha', launch.nonce, 'kilo-owned', 'fixture-stream');
	await saveDelivery('alpha', {
		nonce: launch.nonce,
		pid: process.pid,
		state: 'unconfirmed',
		reason: '',
		thread: 'kilo-owned',
	});
	try {
		await syncTerminalReceivers(h.team);
		// No pre-idle readiness any more (Phillip #22057): nothing before the startup turn ends.
		await Bun.sleep(2200);
		expect(h.inputs.some((input) => input.includes('--mail ready'))).toBe(false);
		await kiloStartupSubmitting('alpha', launch.nonce, 'kilo-owned');
		await kiloStartupSettled('alpha', launch.nonce, 'kilo-owned', 'accepted');
		for (const type of ['busy', 'idle'])
			await observeKiloTurn('alpha', launch.nonce, 'fixture-stream', {
				type: 'session.status',
				properties: { sessionID: 'kilo-owned', status: { type } },
			});
		await waitForNotice(h.inputs, `--mail ready ${launch.nonce}`);
		expect((await readActivity('alpha'))?.state).toBe('idle');
		expect((await readActivity('alpha'))?.launch?.phase).toBe('connecting');
	} finally {
		await stopTerminalReceivers(h.team);
	}
});
