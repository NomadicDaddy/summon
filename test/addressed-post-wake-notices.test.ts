import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { CHECKPOINT_NOTICE_INSTRUCTION } from '../src/checkpoint-work.ts';
import { prepareLocalRoomNotice } from '../src/local-room-live.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { atomicWrite } from '../src/mail-files.ts';
import { currentRoomRequest } from '../src/room-current-request.ts';
import { saveRoomWakePolicy } from '../src/room-wake-policy.ts';
import {
	roomWakeCauses,
	WAKE_CAUSE_LIMIT,
	WAKE_NOTICE_MAX,
	wakeCauseText,
} from '../src/room-wake.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const saved = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
	quiet: process.env.SUMMON_ROOM_WAKE_QUIET_MS,
};
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	// A named fixture session; each test sets SUMMON_AGENT to the member it reads as.
	process.env.SUMMON_NONCE = 'wake-cause-fixture';
	process.env.SUMMON_ROOM_WAKE_QUIET_MS = '0';
});
afterEach(async () => {
	if (saved.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = saved.home;
	if (saved.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = saved.agent;
	if (saved.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = saved.nonce;
	if (saved.quiet === undefined) delete process.env.SUMMON_ROOM_WAKE_QUIET_MS;
	else process.env.SUMMON_ROOM_WAKE_QUIET_MS = saved.quiet;
	await fixture.dispose();
});

const post = (
	kind: 'user' | 'agent' | 'cli',
	id: string,
	text: string,
	replyTo: number | null = null,
) => appendLocalEvent({ sender: { kind, id }, text, replyTo, source: 'local' });

test('a room wake names each addressed post and labels the later watermark as the cursor', async () => {
	const own = await post('agent', 'beta', 'An earlier post of mine.');
	const mention = await post('agent', 'alpha', '@beta please look at this.');
	const reply = await post('agent', 'alpha', 'Agreed, without a mention.', own.id);
	const human = await post('user', 'operator', 'Yes');
	await post('agent', 'alpha', 'Routine status for nobody in particular.');
	const later = await post('agent', 'gamma', 'More routine traffic after the causes.');
	process.env.SUMMON_AGENT = 'beta';
	const notice = await prepareLocalRoomNotice('beta', 'cause-fixture');
	expect(notice?.target.through).toBe(later.id);
	// Exactly the causes, in order, with the room's read command; the cursor is labelled as such.
	expect(notice?.text).toBe(
		`summon room through ${later.id} (read cursor); for you: #${mention.id} #${reply.id} ` +
			`#${human.id} (summon --room show <id>).` +
			CHECKPOINT_NOTICE_INSTRUCTION,
	);
	expect((notice?.text ?? '').length).toBeLessThanOrEqual(WAKE_NOTICE_MAX);
});

test('routine peer traffic alone does not wake, and an explicit recipient sees it as cursor only', async () => {
	await post('agent', 'alpha', 'Routine status.');
	const last = await post('agent', 'gamma', 'More routine status.');
	process.env.SUMMON_AGENT = 'beta';
	expect(await prepareLocalRoomNotice('beta', 'routine-fixture')).toBeUndefined();
	process.env.SUMMON_AGENT = '';
	await atomicWrite(
		join(fixture.records, 'steward.json'),
		JSON.stringify(newRecord('steward', fixture.root, 'codex')),
	);
	await saveRoomWakePolicy(['steward']);
	process.env.SUMMON_AGENT = 'steward';
	const notice = await prepareLocalRoomNotice('steward', 'routine-fixture');
	expect(notice?.text).toBe(
		`summon room through ${last.id} (read cursor); nothing in it addresses you.` +
			CHECKPOINT_NOTICE_INSTRUCTION,
	);
});

test('zero, one, five and more than five causes, for both sources', () => {
	const five = [11, 12, 13, 14, 15];
	expect(wakeCauseText('room', 40, [])).toBe(
		'summon room through 40 (read cursor); nothing in it addresses you.',
	);
	expect(wakeCauseText('room', 40, [12])).toBe(
		'summon room through 40 (read cursor); for you: #12 (summon --room show <id>).',
	);
	expect(wakeCauseText('room', 40, five)).toBe(
		'summon room through 40 (read cursor); for you: #11 #12 #13 #14 #15 (summon --room show <id>).',
	);
	expect(wakeCauseText('room', 40, [...five, 16, 17])).toBe(
		'summon room through 40 (read cursor); for you: #11 #12 #13 #14 #15 +2 more in summon ' +
			'--checkpoint manifest (summon --room show <id>).',
	);
	expect(WAKE_CAUSE_LIMIT).toBe(5);
	expect(wakeCauseText('Telegram', 9, [])).toBe(
		'summon Telegram through 9 (read cursor); nothing in it addresses you.',
	);
	expect(wakeCauseText('Telegram', 9, [7])).toBe(
		'summon Telegram through 9 (read cursor); for you: seq 7 (summon --telegram read <seq-1>).',
	);
	expect(wakeCauseText('Telegram', 40, [...five, 16])).toBe(
		'summon Telegram through 40 (read cursor); for you: seq 11 12 13 14 15 +1 more in summon ' +
			'--checkpoint manifest (summon --telegram read <seq-1>).',
	);
});

test('a Telegram sequence is never printed as the cursor that opens it', () => {
	const text = wakeCauseText('Telegram', 9, [7, 8]);
	// telegram read shows what follows its cursor, so seq 7 opens from 6; the template says so.
	expect(text).toContain('summon --telegram read <seq-1>');
	expect(text).not.toMatch(/summon --telegram read \d/);
});

test('the worst case fits the 384-character notice budget for both sources', () => {
	const max = Number.MAX_SAFE_INTEGER;
	for (const source of ['room', 'Telegram'] as const) {
		for (const count of [0, 1, WAKE_CAUSE_LIMIT, max]) {
			// Only the first five are printed; a huge cause count only widens the overflow number.
			const causes = Array.from({ length: Math.min(count, WAKE_CAUSE_LIMIT) }, () => max);
			let text = wakeCauseText(source, max, causes);
			if (count > WAKE_CAUSE_LIMIT)
				text = text.replace(
					' (summon',
					` +${max} more in summon --checkpoint manifest (summon`,
				);
			const notice = text + CHECKPOINT_NOTICE_INSTRUCTION;
			expect(notice.length).toBeLessThanOrEqual(WAKE_NOTICE_MAX);
			expect(notice).toMatch(/^[\x20-\x7e]*$/);
		}
	}
});

test('the notice says it needs no reply itself, never that the posts it names need none', () => {
	// A bare "No reply." read to a Kilo seat as an order not to answer the operator (#21104).
	expect(CHECKPOINT_NOTICE_INSTRUCTION).not.toMatch(/\bNo reply\.$/);
	expect(CHECKPOINT_NOTICE_INSTRUCTION).toEndWith(
		' This notice needs no reply; the posts it names may.',
	);
});

test('causes are mentions, replies to own posts, human and CLI posts, never routine peers', () => {
	const ownIds = new Set([7]);
	const events = [
		{ id: 1, sender: { kind: 'agent', id: 'alpha' }, text: '@beta here', replyTo: null },
		{ id: 2, sender: { kind: 'agent', id: 'alpha' }, text: 'reply', replyTo: 7 },
		{ id: 3, sender: { kind: 'user', id: 'operator' }, text: 'Yes', replyTo: 99 },
		{ id: 4, sender: { kind: 'cli', id: 'cli' }, text: 'note', replyTo: null },
		{ id: 5, sender: { kind: 'agent', id: 'alpha' }, text: 'routine', replyTo: null },
		{ id: 6, sender: { kind: 'agent', id: 'alpha' }, text: '@betamax is not beta', replyTo: 8 },
	];
	expect(roomWakeCauses('beta', events, ownIds).map((event) => event.id)).toEqual([1, 2, 3, 4]);
});

test('the old-backlog suffix stays a separate bounded message after the budgeted notice', async () => {
	// More than 100 unread with a human post among them adds currentRoomRequest's read-only escape.
	for (let index = 0; index < 101; index++) await post('agent', 'alpha', `routine ${index}`);
	const human = await post('user', 'operator', '@beta are you there?');
	process.env.SUMMON_AGENT = 'beta';
	const text = (await prepareLocalRoomNotice('beta', 'backlog-fixture'))?.text ?? '';
	const head =
		`summon room through ${human.id} (read cursor); for you: #${human.id} ` +
		'(summon --room show <id>).' +
		CHECKPOINT_NOTICE_INSTRUCTION;
	expect(text).toStartWith(head);
	expect(head.length).toBeLessThanOrEqual(WAKE_NOTICE_MAX);
	const suffix = text.slice(head.length);
	expect(suffix).toStartWith(` Latest unread human message: #${human.id}.`);
	expect(suffix).toContain(`summon --room read ${human.id - 1}`);
	// The suffix is currentRoomRequest's own message, appended whole; the cause budget never trims it.
	expect(suffix).toBe(await currentRoomRequest('beta'));
});
