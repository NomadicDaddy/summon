import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { currentRoomInputs } from '../src/current-request-selection.ts';
import { appendLocalEvent, type LocalEvent, localEvents } from '../src/local-room.ts';
import {
	MAX_GROUP_MEMBERS,
	mentionedGroups,
	resolveRoomGroups,
	validRoomGroups,
} from '../src/room-groups.ts';
import { addressedTo, roomWakeCauses } from '../src/room-wake.ts';
import { presence, presenceStore } from './fixtures/presence-groups.ts';

const store = presenceStore();

test('only whole @online and @offline tokens outside quotes and code are groups', () => {
	expect(mentionedGroups('@online status in five')).toEqual(['online']);
	expect(mentionedGroups('@OFFLINE please read')).toEqual(['offline']);
	expect(mentionedGroups('@offline and @online, then @online again')).toEqual([
		'online',
		'offline',
	]);
	for (const text of [
		'@onlineExtra is a name, not a group',
		'@online-team is not a group',
		'mail me at ops@online',
		'> @online quoted from earlier',
		'an example: `@offline`',
		'he wrote "@online" once',
		'```\n@offline inside a fence\n```',
		'@all hands',
	])
		expect(mentionedGroups(text)).toEqual([]);
});

test('groups resolve from verified presence only; unknown and the sender select neither', async () => {
	await store.register('ada');
	await store.register('bob', 'codex');
	await store.register('cy', 'kilo');
	await store.register('dee', 'grok');
	await writeFile(join(store.records(), 'eve.json'), '{ not json');
	const { resolve, asked } = presence({ ada: 'online', bob: 'offline', cy: 'unknown' });

	expect(
		await resolveRoomGroups('@online @offline', { kind: 'user', id: 'operator' }, resolve),
	).toEqual({ online: ['ada'], offline: ['bob'] });
	expect(
		await resolveRoomGroups('@online @offline', { kind: 'agent', id: 'ada' }, resolve),
	).toEqual({ online: [], offline: ['bob'] });
	// An unreadable registration is never asked about; the agent sender is never its own recipient.
	// The harness's alpha and beta get no verdict, so like cy and dee they select neither group.
	expect(asked).toEqual([
		['ada', 'alpha', 'beta', 'bob', 'cy', 'dee'],
		['alpha', 'beta', 'bob', 'cy', 'dee'],
	]);

	expect(await resolveRoomGroups('plain post', { kind: 'user', id: 'operator' }, resolve)).toBe(
		undefined,
	);
	expect(asked).toHaveLength(2);
});

test('an empty group is stored as empty, not omitted', async () => {
	await store.register('ada');
	const { resolve } = presence({ ada: 'offline' });
	expect(
		await resolveRoomGroups('@online anyone?', { kind: 'user', id: 'operator' }, resolve),
	).toEqual({ online: [] });
});

test('resolved groups are stored with the message and replay does not re-resolve them', async () => {
	await store.register('ada');
	await store.register('bob', 'codex');
	const sent = await appendLocalEvent(
		{
			sender: { kind: 'agent', id: 'steward' },
			text: '@offline start when you can',
			replyTo: null,
			source: 'local',
		},
		presence({ ada: 'online', bob: 'offline' }).resolve,
	);
	expect(sent.groups).toEqual({ offline: ['bob'] });

	// Presence changes after the send; the stored list is what every reader sees.
	const later = presence({ ada: 'offline', bob: 'online' });
	const [stored] = await localEvents();
	expect(stored?.groups).toEqual({ offline: ['bob'] });
	expect(later.asked).toEqual([]);

	const plain = await appendLocalEvent({
		sender: { kind: 'agent', id: 'steward' },
		text: 'no group here',
		replyTo: null,
		source: 'local',
	});
	expect(plain.groups).toBeUndefined();
	expect(JSON.stringify((await localEvents())[1])).not.toContain('groups');
});

test('a caller that already resolved groups is not resolved again, and malformed groups refuse', async () => {
	await store.register('ada');
	const { resolve, asked } = presence({ ada: 'offline' });
	const event = await appendLocalEvent(
		{
			sender: { kind: 'user', id: '456' },
			text: '@online mirrored',
			replyTo: null,
			source: 'telegram:1:2:3',
			groups: { online: ['ada'] },
		},
		resolve,
	);
	expect(event.groups).toEqual({ online: ['ada'] });
	expect(asked).toEqual([]);
	const refused = await appendLocalEvent({
		sender: { kind: 'user', id: 'operator' },
		text: 'bad',
		replyTo: null,
		source: 'local',
		groups: { everyone: ['ada'] } as never,
	}).catch(String);
	expect(refused).toContain('Invalid room groups.');
});

test('stored groups must be distinct canonical slugs in a bounded list', () => {
	expect(validRoomGroups({ online: ['ada', 'bob.2'], offline: [] })).toBe(true);
	for (const groups of [
		{ online: ['Ada'] },
		{ online: ['../ada'] },
		{ online: ['ada', 'ada'] },
		{ online: [7] },
		{ everyone: ['ada'] },
		{ online: Array.from({ length: MAX_GROUP_MEMBERS + 1 }, (_, i) => `m${i}`) },
		['ada'],
	])
		expect(validRoomGroups(groups)).toBe(false);
});

test('groups handed to a writer must match the group tokens in its text exactly', async () => {
	await store.register('ada');
	const send = (text: string, groups: object) =>
		appendLocalEvent({
			sender: { kind: 'user', id: 'operator' },
			text,
			replyTo: null,
			source: 'local',
			groups,
		}).catch(String);
	const mismatch = 'Room groups do not match the group mentions in the message.';
	expect(await send('@offline please', { online: ['ada'] })).toContain(mismatch);
	expect(await send('@online @offline', { online: ['ada'] })).toContain(mismatch);
	expect(await send('no group at all', { online: [] })).toContain(mismatch);
	expect(await send('`@online` quoted only', { online: ['ada'] })).toContain(mismatch);
	expect(await localEvents()).toEqual([]);
});

test('group members count as addressed for checkpoint, current requests and rest evidence', () => {
	const event = { text: '@online heads up', groups: { online: ['ada'] } };
	expect(addressedTo(event, 'ada')).toBe(true);
	expect(addressedTo(event, 'bob')).toBe(false);
	expect(addressedTo({ text: '@bob only' }, 'bob')).toBe(true);
	const history: LocalEvent[] = [
		{
			id: 1,
			at: new Date().toISOString(),
			sender: { kind: 'agent', id: 'steward' },
			text: '@online status?',
			replyTo: null,
			source: 'local',
			groups: { online: ['ada'] },
		},
	];
	expect(currentRoomInputs('ada', history, 0).map((input) => input.id)).toEqual(['1']);
	expect(currentRoomInputs('bob', history, 0)).toEqual([]);
});

test('a wake notice counts a group member as addressed, and nobody outside the group', () => {
	const events = [
		{
			sender: { kind: 'agent', id: 'steward' },
			text: '@online heads up',
			replyTo: null,
			groups: { online: ['ada'] },
		},
		{ sender: { kind: 'agent', id: 'steward' }, text: 'routine peer note', replyTo: null },
	];
	expect(roomWakeCauses('ada', events, new Set())).toEqual(events.slice(0, 1));
	expect(roomWakeCauses('bob', events, new Set())).toEqual([]);
});
