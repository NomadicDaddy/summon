import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

import type { Team } from '../src/desktop/team.ts';

import { mailHarness } from './fixtures/mail-harness.ts';

/*
 * remediation-20261023-stop-decides-on-stale-snapshot clause 4, through the registered handler.
 * maintenanceIpc registers team:stop on Electron's ipcMain; this file stands in for Electron,
 * captures every registered handler, and invokes team:stop the way preload's invoke reaches it.
 * The control: against 08bb897a's maintenance-ipc.ts this file fails, because that handler
 * stopped at once and answered nothing.
 */
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
const { idleThenBusy, stopHarness } = await import('./fixtures/stop-harness.ts');

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	handlers.clear();
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

/** The registered team:stop handler for this Team, called as the renderer's invoke calls it. */
function registeredStop(team: Team) {
	const trusted: string[] = [];
	maintenanceIpc(team, () => {
		trusted.push('checked');
	});
	const handler = handlers.get('team:stop');
	if (!handler) throw new Error('team:stop was not registered.');
	return {
		trusted,
		stop: (name: unknown, confirmed?: unknown) => handler({}, name, confirmed),
	};
}

test('the handler refuses an unconfirmed stop of a session that just went busy', async () => {
	const { h, beginTurn } = await idleThenBusy();
	await beginTurn();
	const ipc = registeredStop(h.team);
	expect(await ipc.stop('alpha', false)).toEqual({ needsConfirm: true });
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('running');
	expect(h.terminated).toEqual([]);
	expect(await ipc.stop('alpha', true)).toEqual({ stopped: true });
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
	expect(ipc.trusted).toHaveLength(2);
	await h.team.shutdown();
});

test('anything but a literal true counts as unconfirmed', async () => {
	const { h, beginTurn } = await idleThenBusy();
	await beginTurn();
	const ipc = registeredStop(h.team);
	for (const confirmed of [undefined, 'true', 1, null])
		expect(await ipc.stop('alpha', confirmed)).toEqual({ needsConfirm: true });
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('running');
	await h.team.shutdown();
});

test('the handler resolves a display name, and an idle session stops at once', async () => {
	const { h } = await idleThenBusy();
	const ipc = registeredStop(h.team);
	expect(await ipc.stop('Alpha', false)).toEqual({ stopped: true });
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
	await h.team.shutdown();
});

test('a non-string name is refused before anything is stopped', async () => {
	const h = stopHarness();
	await h.team.start('alpha');
	const ipc = registeredStop(h.team);
	expect(ipc.stop(42, true)).rejects.toThrow('Invalid agent.');
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('running');
	await h.team.shutdown();
});
