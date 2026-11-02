import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { stopNeedsConfirm, stopWithConfirm } from '../src/desktop/stop-confirm.ts';
import { stopIfConfirmed, stopNeedsConfirmNow } from '../src/desktop/stop-evidence.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { idleThenBusy, stopHarness } from './fixtures/stop-harness.ts';

/*
 * remediation-20261023-stop-decides-on-stale-snapshot. On installed 0.31.3 a Stop pressed the
 * moment Claude's turn went busy asked nothing and ended the session: the renderer decided on a
 * snapshot published before the turn began, and team:stop stopped without looking again. The
 * main process now reads the session's own evidence when the stop arrives.
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

test('control: the row published before the turn began says Stop need not ask', async () => {
	const { h, stale, beginTurn } = await idleThenBusy();
	await beginTurn();
	// This is the renderer's whole decision on the old path, and it is wrong for the live session.
	expect(stopNeedsConfirm(stale)).toBe(false);
	expect(await stopNeedsConfirmNow(h.team, 'alpha')).toBe(true);
	await h.team.shutdown();
});

test('an unconfirmed stop of a session that just went busy is refused', async () => {
	const { h, beginTurn } = await idleThenBusy();
	await beginTurn();
	expect(await stopIfConfirmed(h.team, 'alpha', false)).toEqual({ needsConfirm: true });
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('running');
	expect(h.terminated).toEqual([]);
	expect(await stopIfConfirmed(h.team, 'alpha', true)).toEqual({ stopped: true });
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
	await h.team.shutdown();
});

test('the Stop click on the stale row asks once, and Cancel keeps the session', async () => {
	const { h, stale, beginTurn } = await idleThenBusy();
	await beginTurn();
	const asked: string[] = [];
	const stop = (confirmed: boolean) => stopIfConfirmed(h.team, 'alpha', confirmed);
	await stopWithConfirm(stale, (message) => (asked.push(message), false), stop);
	expect(asked).toHaveLength(1);
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('running');
	await stopWithConfirm(stale, () => true, stop);
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
	await h.team.shutdown();
});

test('an idle session still stops at once', async () => {
	const { h, stale } = await idleThenBusy();
	let asked = false;
	const stop = (confirmed: boolean) => stopIfConfirmed(h.team, 'alpha', confirmed);
	await stopWithConfirm(stale, () => ((asked = true), false), stop);
	expect(asked).toBe(false);
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
	await h.team.shutdown();
});

test('a turn record the main process cannot read makes Stop ask', async () => {
	const { h, nonce } = await idleThenBusy();
	await Bun.write(join(fixture.records, `runtime/alpha/${nonce}.claude-turn`), '{');
	expect(await stopIfConfirmed(h.team, 'alpha', false)).toEqual({ needsConfirm: true });
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('running');
	await h.team.shutdown();
});

test('a session that is not running is left to Team.stop', async () => {
	const h = stopHarness();
	expect(await stopNeedsConfirmNow(h.team, 'alpha')).toBe(false);
	await h.team.shutdown();
});
