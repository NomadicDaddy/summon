import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { appendLocalEvent } from '../src/local-room.ts';
import { effectiveMember } from '../src/member-role.ts';
import { preparePm } from '../src/pm-command.ts';
import { localCursorPath } from '../src/room-cursor.ts';
import { receivesRoutineRoom, saveRoomWakePolicy } from '../src/room-wake-policy.ts';
import { acquireSessionLock } from '../src/session-lock.ts';
import { loadAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = { home: process.env.SUMMON_HOME, agent: process.env.SUMMON_AGENT };
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	// Registering a PM is an operator action.
	delete process.env.SUMMON_AGENT;
	for (const text of ['one', 'two', 'three'])
		await appendLocalEvent({
			sender: { kind: 'user', id: 'operator' },
			text,
			replyTo: null,
			source: 'local',
		});
});
afterEach(async () => {
	if (previous.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous.home;
	if (previous.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previous.agent;
	await fixture.dispose();
});

test('a PM name with a live older session is refused, with its cursors and record untouched', async () => {
	// A hand-deleted registration can leave its session running with its cursors in place.
	await mkdir(join(fixture.records, 'runtime', 'scout'), { recursive: true });
	await writeFile(localCursorPath('scout'), '1');
	const live = await acquireSessionLock('scout');
	if (!live) throw new Error('The test holds the only lock.');
	let refused = '';
	try {
		await preparePm(['Scout', '--using', 'claude']);
	} catch (error: unknown) {
		refused = error instanceof Error ? error.message : String(error);
	} finally {
		await live.release();
	}
	expect(refused).toContain('A session is still running under the name Scout');
	expect(await readFile(localCursorPath('scout'), 'utf8')).toBe('1');
	expect(await loadAgent('scout')).toBeUndefined();
});

test('a new PM starts at the start of today and leaves its name free for the launch that follows', async () => {
	expect(await preparePm(['Scout', '--using', 'claude'])).toBe('scout');
	expect((await loadAgent('scout'))?.memberType).toBe('pm');
	// All three posts are from today, so the new PM reads them.
	expect(await readFile(localCursorPath('scout'), 'utf8')).toBe('0');
	const launch = await acquireSessionLock('scout');
	expect(launch).toBeDefined();
	await launch?.release();
});

test('the suggested PM name grants no extra permission, wake selection or duty ownership', async () => {
	for (const name of ['Steward', 'Harbor']) {
		const slug = await preparePm([name]);
		const record = await loadAgent(slug);
		if (!record) throw new Error('Expected the created PM.');
		expect(record.memberType).toBe('pm');
		expect(record.canStopResting).toBe(false);
		expect(await receivesRoutineRoom(slug)).toBe(false);
	}
	const steward = await loadAgent('steward');
	const harbor = await loadAgent('harbor');
	if (!steward || !harbor) throw new Error('Expected both PM records.');
	expect(effectiveMember(steward).expertise).toBe(effectiveMember(harbor).expertise);
	expect(effectiveMember(harbor).expertise).toContain('only after the answer is Yes');
	await saveRoomWakePolicy(['harbor']);
	expect(await receivesRoutineRoom('harbor')).toBe(true);
	expect(await receivesRoutineRoom('steward')).toBe(false);
});
