import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

import type { Team } from '../src/desktop/team.ts';

import { readRest } from '../src/rest.ts';
import { updateAgentRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { readyOwnedRest, writeRestTurn } from './fixtures/rest-turn.ts';
import { stopHarness } from './fixtures/stop-harness.ts';

type Handler = (event: object, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
await mock.module('electron', () => ({
	BrowserWindow: { fromWebContents: () => null },
	dialog: {},
	ipcMain: {
		handle: (channel: string, handler: Handler) => {
			handlers.set(channel, handler);
		},
	},
}));
const { maintenanceIpc } = await import('../src/desktop/maintenance-ipc.ts');

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const original = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	handlers.clear();
});
afterEach(async () => {
	if (original === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = original;
	await fixture.dispose();
});

function registeredRestStop(team: Team) {
	const trusted: string[] = [];
	maintenanceIpc(team, () => {
		trusted.push('checked');
	});
	const handler = handlers.get('team:stop-rest');
	if (!handler) throw new Error('team:stop-rest was not registered.');
	return {
		trusted,
		stop: (name: unknown, confirmation: unknown) => handler({}, name, confirmation),
	};
}

test('registered Zzz handler refuses a busy running provider even after a profile provider edit', async () => {
	const h = stopHarness();
	try {
		const state = await readyOwnedRest(fixture, h);
		await updateAgentRecord('alpha', (record) => {
			record.provider = 'codex';
		});
		await writeRestTurn(fixture.records, 'claude', 'alpha', state.nonce, 'busy');
		const ipc = registeredRestStop(h.team);
		const failure: unknown = await Promise.resolve(ipc.stop('Alpha', state.id)).catch(
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).toContain('claude turn is busy');
		expect(ipc.trusted).toEqual(['checked']);
		expect(h.terminated).toEqual([]);
		expect(h.team.sessions.get('alpha')?.agent.status).toBe('running');
		expect((await readRest('alpha'))?.mode).toBe('ready');
	} finally {
		await h.team.shutdown();
	}
});

test('registered Zzz handler stops an idle owned session with current explicit consent', async () => {
	const h = stopHarness();
	try {
		const state = await readyOwnedRest(fixture, h);
		const ipc = registeredRestStop(h.team);
		await ipc.stop('Alpha', state.id);
		expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
		expect((await readRest('alpha'))?.mode).toBe('stopped');
	} finally {
		await h.team.shutdown();
	}
});

test('registered Zzz handler rejects malformed arguments and sessions it does not own', async () => {
	const h = stopHarness();
	const ipc = registeredRestStop(h.team);
	for (const [name, confirmation, reason] of [
		[42, 'confirmation', 'Invalid rest confirmation'],
		['alpha', false, 'Invalid rest confirmation'],
		['alpha', 'confirmation', 'not running in this Team Window'],
	] as const) {
		const failure: unknown = await Promise.resolve(ipc.stop(name, confirmation)).catch(
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).toContain(reason);
	}
	await h.team.shutdown();
});
