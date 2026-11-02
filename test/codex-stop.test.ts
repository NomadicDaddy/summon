import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Team } from '../src/desktop/team.ts';

import { initializeActivity } from '../src/agent-activity.ts';
import { readRest, stopForRest } from '../src/rest.ts';
import { updateAgentRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { readyOwnedRest } from './fixtures/rest-turn.ts';

let phase: 'idle' | 'busy' | 'unknown' = 'idle';
await mock.module('../src/codex-turn-rpc.ts', () => ({
	readCodexThreadStatuses: (threads: readonly string[]) =>
		Promise.resolve(new Map(threads.map((thread) => [thread, phase]))),
}));
type Handler = (event: object, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
await mock.module('electron', () => ({
	BrowserWindow: { fromWebContents: () => null },
	dialog: {},
	ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler) },
}));
const { maintenanceIpc } = await import('../src/desktop/maintenance-ipc.ts');
const { stopWithConfirm } = await import('../src/desktop/stop-confirm.ts');
const { stopRestSession } = await import('../src/desktop/rest-stop.ts');
const { stopHarness } = await import('./fixtures/stop-harness.ts');
let fixture: Awaited<ReturnType<typeof mailHarness>>;
let h: ReturnType<typeof stopHarness>;
const priorHome = process.env.SUMMON_HOME;
const priorCodexHome = process.env.CODEX_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.CODEX_HOME = join(fixture.root, 'codex');
	phase = 'idle';
	handlers.clear();
	h = stopHarness();
	for (const name of ['alpha', 'beta'])
		await updateAgentRecord(name, (record) => {
			record.provider = 'codex';
		});
});
afterEach(async () => {
	await h.team.shutdown();
	if (priorHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = priorHome;
	if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
	else process.env.CODEX_HOME = priorCodexHome;
	await fixture.dispose();
});
async function bind(name: string) {
	const session = h.team.sessions.get(name);
	if (!session) throw new Error('Missing fixture session.');
	await initializeActivity(name, session.launch.nonce, 'codex');
	await writeFile(
		join(fixture.records, `runtime/${name}/${session.launch.nonce}.binding`),
		`${name}-thread`,
	);
}
function registeredStop(team: Team) {
	maintenanceIpc(team, () => {});
	const handler = handlers.get('team:stop');
	if (!handler) throw new Error('Missing registered Stop.');
	return (confirmed: boolean) =>
		handler({}, 'alpha', confirmed) as Promise<{ stopped: true } | { needsConfirm: true }>;
}

test.each(['busy', 'unknown'] as const)(
	'%s native evidence with self-reported idle refuses unconfirmed Stop',
	async (value) => {
		await h.team.start('alpha');
		await bind('alpha');
		phase = value;
		expect(await registeredStop(h.team)(false)).toEqual({ needsConfirm: true });
		expect(h.terminated).toEqual([]);
		expect(h.team.sessions.get('alpha')?.agent.status).toBe('running');
	},
);

test('a stale idle row asks once, Cancel preserves both sessions, and confirmed Stop affects only selected', async () => {
	for (const name of ['alpha', 'beta']) {
		await h.team.start(name);
		await bind(name);
	}
	let stale = (await h.team.snapshot()).agents.find((agent) => agent.slug === 'alpha');
	// The first roster refresh is deliberately nonblocking; wait for its idle observation.
	for (let attempt = 0; stale?.providerTurn !== undefined && attempt < 100; attempt++) {
		await Bun.sleep(10);
		stale = (await h.team.snapshot()).agents.find((agent) => agent.slug === 'alpha');
	}
	if (!stale) throw new Error('Missing idle snapshot.');
	expect(stale.providerTurn).toBeUndefined();
	phase = 'busy';
	const stop = registeredStop(h.team);
	let questions = 0;
	await stopWithConfirm(
		stale,
		() => {
			questions++;
			return false;
		},
		stop,
	);
	expect(questions).toBe(1);
	expect(h.terminated).toEqual([]);
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('running');
	expect(h.team.sessions.get('beta')?.agent.status).toBe('running');
	await stopWithConfirm(
		stale,
		() => {
			questions++;
			return true;
		},
		stop,
	);
	expect(questions).toBe(2);
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
	expect(h.team.sessions.get('beta')?.agent.status).toBe('running');
	expect(h.terminated).toHaveLength(1);
});

test('loaded native idle stops immediately without a question', async () => {
	await h.team.start('alpha');
	await bind('alpha');
	const row = (await h.team.snapshot()).agents.find((agent) => agent.slug === 'alpha');
	if (!row) throw new Error('Missing fixture row.');
	let questions = 0;
	await stopWithConfirm(
		row,
		() => {
			questions++;
			return false;
		},
		registeredStop(h.team),
	);
	expect(questions).toBe(0);
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
});

test('a cached busy roster cannot force a question after the native turn becomes idle', async () => {
	await h.team.start('alpha');
	await bind('alpha');
	const row = (await h.team.snapshot()).agents.find((agent) => agent.slug === 'alpha');
	if (!row) throw new Error('Missing fixture row.');
	let questions = 0;
	await stopWithConfirm(
		{ ...row, providerTurn: 'busy' },
		() => {
			questions++;
			return false;
		},
		registeredStop(h.team),
	);
	expect(questions).toBe(0);
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
});

test('ordinary Stop cannot act on a replacement launch after an asynchronous idle read', async () => {
	await h.team.start('alpha');
	await bind('alpha');
	const session = h.team.sessions.get('alpha');
	if (!session) throw new Error('Missing launch.');
	const { stopIfConfirmed } = await import('../src/desktop/stop-evidence.ts');
	let reads = 0;
	const sessions = new Map(h.team.sessions);
	sessions.get = () => (++reads === 1 ? session : { ...session });
	let stopped = false;
	expect(
		await stopIfConfirmed(
			{
				sessions,
				stop: () => {
					stopped = true;
					return Promise.resolve({ verified: true as const });
				},
			},
			'alpha',
			false,
		),
	).toEqual({ needsConfirm: true });
	expect(stopped).toBe(false);
});

test('rest stop refuses busy and unknown without consuming consent; loaded idle stops', async () => {
	const state = await readyOwnedRest(fixture, h);
	await bind('alpha');
	for (const value of ['busy', 'unknown'] as const) {
		phase = value;
		const failure: unknown = await stopForRest(
			'alpha',
			state.id,
			(nonce) => stopRestSession(h.team, 'alpha', nonce),
			'codex',
		).catch((error: unknown) => error);
		expect(String(failure)).toContain('turn is');
		expect(h.terminated).toEqual([]);
		expect((await readRest('alpha'))?.mode).toBe('ready');
	}
	phase = 'idle';
	await stopForRest(
		'alpha',
		state.id,
		(nonce) => stopRestSession(h.team, 'alpha', nonce),
		'codex',
	);
	expect((await readRest('alpha'))?.mode).toBe('stopped');
});
