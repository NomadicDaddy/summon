import { afterEach, beforeEach, expect, test } from 'bun:test';

import { initializeActivity } from '../src/agent-activity.ts';
import { stopRestSession } from '../src/desktop/rest-stop.ts';
import { tickRest } from '../src/desktop/rest.ts';
import { restStopStatus } from '../src/rest-stop.ts';
import { RestStopRefusedError } from '../src/rest-turn.ts';
import { readRest, refreshRest, stopForRest } from '../src/rest.ts';
import { updateAgentRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { readyOwnedRest, writeRestTurn } from './fixtures/rest-turn.ts';
import { stopHarness } from './fixtures/stop-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const original = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (original === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = original;
	await fixture.dispose();
});

async function ready(h: ReturnType<typeof stopHarness>, name = 'alpha') {
	return readyOwnedRest(fixture, h, name);
}

test('control: the old callback stops a fixture whose turn starts after the consent check', async () => {
	const h = stopHarness();
	try {
		const state = await ready(h);
		await stopForRest(
			'alpha',
			state.id,
			async () => {
				await writeRestTurn(fixture.records, 'claude', 'alpha', state.nonce, 'busy');
				await h.team.stop('alpha', 'rest-work');
			},
			'claude',
		);
		expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
	} finally {
		await h.team.shutdown();
	}
});

test('the owned boundary refuses that same late turn without consuming consent', async () => {
	const h = stopHarness();
	try {
		const state = await ready(h);
		const error: unknown = await stopForRest(
			'alpha',
			state.id,
			async (nonce) => {
				await writeRestTurn(fixture.records, 'claude', 'alpha', nonce, 'busy');
				await stopRestSession(h.team, 'alpha', nonce);
			},
			'claude',
		).catch((value: unknown) => value);
		expect(error).toBeInstanceOf(RestStopRefusedError);
		expect(h.terminated).toEqual([]);
		expect(h.team.sessions.get('alpha')?.agent.status).toBe('running');
		expect(h.team.sessions.get('alpha')?.stopRequested).not.toBe(true);
		expect((await readRest('alpha'))?.mode).toBe('ready');
	} finally {
		await h.team.shutdown();
	}
});

test('a replacement owned launch is not stopped with the earlier launch consent', async () => {
	const h = stopHarness();
	try {
		const state = await ready(h);
		let replacement = '';
		const error: unknown = await stopForRest(
			'alpha',
			state.id,
			async (nonce) => {
				await h.team.stop('alpha');
				await h.team.start('alpha');
				replacement = h.team.sessions.get('alpha')?.launch.nonce ?? '';
				await initializeActivity('alpha', replacement, 'claude');
				await stopRestSession(h.team, 'alpha', nonce);
			},
			'claude',
		).catch((value: unknown) => value);
		expect(error).toBeInstanceOf(RestStopRefusedError);
		expect(replacement).not.toBe(state.nonce);
		expect(h.team.sessions.get('alpha')?.agent.status).toBe('running');
		expect((await refreshRest('alpha'))?.mode).toBe('awake');
	} finally {
		await h.team.shutdown();
	}
});

test('delegated processing refuses a busy provider through its real Team callback', async () => {
	const h = stopHarness();
	try {
		await initializeActivity('alpha', 'test-launch');
		await updateAgentRecord('alpha', (record) => {
			record.canStopResting = true;
		});
		const state = await ready(h, 'beta');
		expect((await fixture.run(['--rest', 'stop', 'beta', state.id], 'alpha')).code).toBe(0);
		await writeRestTurn(fixture.records, 'claude', 'beta', state.nonce, 'busy');
		await tickRest(h.team);
		expect((await restStopStatus('beta'))?.state).toBe('failed');
		expect((await restStopStatus('beta'))?.detail).toContain('turn is busy');
		expect(h.terminated).toEqual([]);
		expect(h.team.sessions.get('beta')?.agent.status).toBe('running');
		expect((await readRest('beta'))?.mode).toBe('ready');
	} finally {
		await h.team.shutdown();
	}
});

test('idle owned session stops and retains the existing stopped/resume state', async () => {
	const h = stopHarness();
	try {
		const state = await ready(h);
		await stopForRest(
			'alpha',
			state.id,
			(nonce) => stopRestSession(h.team, 'alpha', nonce),
			'claude',
		);
		expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
		expect((await readRest('alpha'))?.mode).toBe('stopped');
		expect((await readRest('alpha'))?.resume).toBe(true);
	} finally {
		await h.team.shutdown();
	}
});

test.skipIf(process.platform !== 'win32')(
	'owned input cannot submit after the final stop boundary',
	async () => {
		let entered = () => {};
		let release = () => {};
		const terminating = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = stopHarness(async () => {
			entered();
			await released;
		});
		let stopping: Promise<void> | undefined;
		try {
			const state = await ready(h);
			const session = h.team.sessions.get('alpha');
			if (!session) throw new Error('Missing fixture session.');
			const writes: string[] = [];
			session.pty.write = (text) => {
				writes.push(String(text));
			};
			stopping = stopForRest(
				'alpha',
				state.id,
				(nonce) => stopRestSession(h.team, 'alpha', nonce),
				'claude',
			);
			await Promise.race([
				terminating,
				stopping.then(() => {
					throw new Error('Stop finished before the boundary barrier.');
				}),
			]);
			expect(session.stopRequested).toBe(true);
			await h.team.input('alpha', '\r');
			expect(writes).toEqual([]);
			release();
			await stopping;
			expect((await readRest('alpha'))?.mode).toBe('stopped');
		} finally {
			release();
			await stopping?.catch(() => {});
			await h.team.shutdown();
		}
	},
);
