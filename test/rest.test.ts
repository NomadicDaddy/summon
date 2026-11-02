import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { createBoardItem } from '../src/board.ts';
import { nudgeRest } from '../src/desktop/rest-nudge.ts';
import { tickRest } from '../src/desktop/rest.ts';
import { Team } from '../src/desktop/team.ts';
import { setHibernation } from '../src/hibernation.ts';
import { sendHuman } from '../src/local-room-access.ts';
import { pendingMessages, sendMessage } from '../src/mailbox.ts';
import { readRest, refreshRest, restSuppressed, stopForRest } from '../src/rest.ts';
import { directlyAddressed } from '../src/room-wake.ts';
import { createSchedule, listSchedules } from '../src/schedules.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { bindIdleTurn } from './fixtures/provider-idle.ts';
import { notifyLocalRoom } from './fixtures/wake-notice.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeActivity('alpha', 'test-launch');
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});
async function ready(): Promise<string> {
	const result = await fixture.run(['--rest', 'ready'], 'alpha');
	expect(result.code).toBe(0);
	const state = await readRest('alpha');
	if (!state) throw Error(result.error);
	return state.id;
}

test('a failed stop invalidates consent without claiming success or automatically resuming', async () => {
	const id = await ready();
	const failure = new Error('Fixture process-tree stop failed');
	const result: unknown = await stopForRest(
		'alpha',
		id,
		() => Promise.reject(failure),
		'claude',
	).catch((error: unknown) => error);
	expect(result).toBe(failure);
	const state = await readRest('alpha');
	expect(state?.mode).toBe('uncertain');
	expect(state?.resume).toBe(false);
	expect(state?.reason).toContain('Stop failed');
	expect(await restSuppressed('alpha')).toBe(false);
	let retried = false;
	const retry: unknown = await stopForRest(
		'alpha',
		id,
		() => {
			retried = true;
			return Promise.resolve();
		},
		'claude',
	).catch((error: unknown) => error);
	expect(retry).toBeInstanceOf(Error);
	if (!(retry instanceof Error)) throw new Error('Expected stale confirmation failure');
	expect(retry.message).toContain('Rest confirmation changed');
	expect(retried).toBe(false);
	const h = fakeTeam();
	await tickRest(h.team);
	expect(h.launches()).toBe(0);
	expect((await readRest('alpha'))?.mode).toBe('uncertain');
});
function fakeTeam() {
	let launches = 0;
	const team = new Team(
		'bun',
		'cli.ts',
		() => {},
		() => {
			launches++;
			return {
				pid: 1,
				onData: () => ({ dispose() {} }),
				onExit: () => ({ dispose() {} }),
				write() {},
				resize() {},
				kill() {},
			};
		},
	);
	return { team, launches: () => launches };
}
test('only explicit agent readiness enables stopping; new work invalidates the displayed confirmation', async () => {
	expect((await fixture.run(['--rest', 'ready'])).code).toBe(1);
	expect(await readRest('alpha')).toBeUndefined();
	const id = await ready();
	let stopped = 0;
	await sendMessage('beta', 'alpha', 'New assignment');
	const error: unknown = await stopForRest(
		'alpha',
		id,
		() => {
			stopped++;
			return Promise.resolve();
		},
		'claude',
	).catch((e: unknown) => e);
	expect(error).toBeInstanceOf(Error);
	expect(stopped).toBe(0);
	expect((await readRest('alpha'))?.mode).toBe('wake-requested');
});
test('routine and quoted room traffic stays unread without waking; direct addressing clears readiness', async () => {
	await ready();
	await sendHuman('Routine discussion');
	await sendHuman('> @alpha quoted timeline');
	const notices: string[] = [];
	await notifyLocalRoom('alpha', 'fixture', (text) => {
		notices.push(text);
		return Promise.resolve();
	});
	expect(notices).toHaveLength(0);
	expect(await restSuppressed('alpha')).toBe(true);
	expect(directlyAddressed('```\n@all\n```', 'alpha')).toBe(false);
	await sendHuman('@alpha please check this');
	expect(await restSuppressed('alpha')).toBe(false);
	await notifyLocalRoom('alpha', 'fixture', (text) => {
		notices.push(text);
		return Promise.resolve();
	});
	expect(notices).toHaveLength(1);
});
test('receipt-only mail permits rest; Doing cards block confirmation and refresh', async () => {
	await sendMessage('beta', 'alpha', 'Read receipt', { kind: 'receipt' });
	await ready();
	await createBoardItem({ title: 'Work', owner: 'alpha', state: 'doing' });
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(1);
	expect((await refreshRest('alpha'))?.reason).toContain('Doing');
});

test('rest names the blocking room event and requires acknowledgement of the delivered batch', async () => {
	await sendHuman('@all restarted the Team Window');
	const blocked = await fixture.run(['--rest', 'ready'], 'alpha');
	expect(blocked.code).toBe(1);
	expect(blocked.error).toContain('Room message #1 after acknowledged cursor #0');
	expect(blocked.error).toContain('Read summon --checkpoint');
	const delivered = await fixture.run(['--checkpoint'], 'alpha');
	expect(delivered.code).toBe(0);
	const batch = JSON.parse(delivered.out) as { receipt: string };
	// Delivery alone must not authorize skipping the unread-message gate.
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(1);
	const final = await fixture.run(['--checkpoint', batch.receipt], 'alpha');
	expect(final.code).toBe(0);
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(1);
	expect(
		(
			await fixture.run(
				['--checkpoint', (JSON.parse(final.out) as { receipt: string }).receipt],
				'alpha',
			)
		).code,
	).toBe(0);
	await ready();
});
test('a due schedule wakes a Zzz-stopped owner once; hibernation forbids wake', async () => {
	await createSchedule({ owner: 'alpha', title: 'Fixture', prompt: 'No-op', everyMinutes: 1 });
	const id = await ready();
	await stopForRest('alpha', id, () => Promise.resolve(), 'claude');
	expect((await readRest('alpha'))?.mode).toBe('stopped');
	const state = await listSchedules();
	const schedule = state.schedules[0];
	if (!schedule) throw Error('Missing schedule');
	schedule.nextDueAt = 0;
	await writeFile(join(fixture.records, 'schedules/state.json'), JSON.stringify(state));
	const h = fakeTeam();
	await tickRest(h.team);
	await tickRest(h.team);
	expect(h.launches()).toBe(1);
	expect((await readRest('alpha'))?.mode).toBe('awake');
	await setHibernation('alpha', true);
	const saved = await readRest('alpha');
	await writeFile(
		join(fixture.records, 'runtime/alpha/rest.json'),
		JSON.stringify({ ...saved, mode: 'stopped', resume: true }),
	);
	const other = fakeTeam();
	await tickRest(other.team);
	expect(other.launches()).toBe(0);
});
test('new owner card wakes a resting session; unrelated card does not', async () => {
	await ready();
	await createBoardItem({ title: 'Other work', owner: 'beta', state: 'backlog' });
	expect(await restSuppressed('alpha')).toBe(true);
	await createBoardItem({ title: 'Future work', owner: 'alpha', state: 'backlog' });
	expect(await restSuppressed('alpha')).toBe(false);
});

test('quoted mentions cannot revive a Zzz-stopped session and relaunch invalidates old consent', async () => {
	const id = await ready();
	await stopForRest('alpha', id, () => Promise.resolve(), 'claude');
	const h = fakeTeam();
	await h.team.wakeMentions(await sendHuman('> @alpha is quoted here'));
	expect(h.launches()).toBe(0);
	await initializeActivity('alpha', 'new-launch');
	expect((await refreshRest('alpha'))?.mode).toBe('awake');
	let stopped = false;
	const result: unknown = await stopForRest(
		'alpha',
		id,
		() => {
			stopped = true;
			return Promise.resolve();
		},
		'claude',
	).catch((error: unknown) => error);
	expect(result).toBeInstanceOf(Error);
	expect(stopped).toBe(false);
});

test('idle nudge asks once per episode and never confirms readiness or stops the terminal', async () => {
	const h = fakeTeam();
	await h.team.start('alpha');
	// The nudge needs idle activity from the session's own launch (tool-aware-idle-nudge).
	const launch = h.team.sessions.get('alpha')?.launch.nonce ?? 'no-session';
	await initializeActivity('alpha', launch);
	await bindIdleTurn(fixture.records, 'claude', 'alpha', launch);
	await nudgeRest(h.team, 'alpha', Date.now() + 11 * 60000);
	await nudgeRest(h.team, 'alpha', Date.now() + 12 * 60000);
	expect(await pendingMessages('alpha')).toHaveLength(1);
	expect(await readRest('alpha')).toBeUndefined();
	expect(h.team.sessions.get('alpha')?.agent.status).toBe('running');
});

test('interrupted wake is exposed as uncertain without another launch; live claim is preserved', async () => {
	await ready();
	const saved = await readRest('alpha');
	const path = join(fixture.records, 'runtime/alpha/rest.json');
	await writeFile(path, JSON.stringify({ ...saved, mode: 'waking', wakePid: process.pid }));
	const h = fakeTeam();
	await tickRest(h.team);
	expect((await readRest('alpha'))?.mode).toBe('waking');
	// Omitted PID models a persisted claim whose owner is no longer identifiable.
	await writeFile(path, JSON.stringify({ ...saved, mode: 'waking' }));
	await tickRest(h.team);
	await tickRest(h.team);
	expect((await readRest('alpha'))?.mode).toBe('uncertain');
	expect(h.launches()).toBe(0);
});
