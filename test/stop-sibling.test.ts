import { afterEach, beforeEach, expect, test } from 'bun:test';

import { stopWithConfirm } from '../src/desktop/stop-confirm.ts';
import { stopIfConfirmed } from '../src/desktop/stop-evidence.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { stopHarness } from './fixtures/stop-harness.ts';

/*
 * remediation-20261021-stop-confirms-on-native-busy clause 4. The renderer passes the selected
 * slug to team:stop, which calls Team.stop with it unchanged (maintenance-ipc.ts, through
 * stop-evidence.ts). These tests cover the rest of that path with two live sessions: a confirmed
 * Stop ends only its own session's process tree, a cancelled Stop dispatches nothing, and the
 * sibling keeps running either way.
 */
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

test('Stop ends only the selected session; its sibling keeps running', async () => {
	const h = stopHarness();
	await h.team.start('alpha');
	await h.team.start('beta');
	const alphaPid = h.team.sessions.get('alpha')?.pty.pid;
	const betaPid = h.team.sessions.get('beta')?.pty.pid;
	expect(alphaPid).not.toBe(betaPid);
	await h.team.stop('alpha');
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
	expect(h.team.sessions.get('beta')?.agent.status).toBe('running');
	if (process.platform === 'win32') expect(h.terminated).toEqual([alphaPid as number]);
	const roster = (await h.team.snapshot()).agents;
	expect(roster.find((agent) => agent.slug === 'beta')?.ownedSession).toBe(true);
	expect(roster.find((agent) => agent.slug === 'alpha')?.ownedSession).toBe(false);
	await h.team.shutdown();
});

test('a cancelled Stop on a busy session dispatches nothing', async () => {
	const h = stopHarness();
	await h.team.start('alpha');
	await h.team.start('beta');
	const alpha = (await h.team.snapshot()).agents.find((agent) => agent.slug === 'alpha');
	if (!alpha) throw new Error('Missing alpha.');
	// The renderer's click: ask, and dispatch team:stop only when the operator accepts.
	const busy = { ...alpha, providerTurn: 'busy' as const };
	const stop = (confirmed: boolean) => stopIfConfirmed(h.team, busy.slug, confirmed);
	await stopWithConfirm(busy, () => false, stop);
	expect(h.terminated).toEqual([]);
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('running');
	expect(h.team.sessions.get('beta')?.agent.status).toBe('running');
	await stopWithConfirm(busy, () => true, stop);
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
	expect(h.team.sessions.get('beta')?.agent.status).toBe('running');
	await h.team.shutdown();
});
