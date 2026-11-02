import { expect, test } from 'bun:test';

import { recoverMissedMentionWakes } from '../src/desktop/mention-recovery.ts';
import { appendLocalEvent, localEvents } from '../src/local-room.ts';
import { groupWakeTargets } from '../src/room-groups.ts';
import { addressedTo, explicitNames } from '../src/room-wake.ts';
import { recordRoomEvent, roomEvents } from '../src/telegram-room.ts';
import { presence, presenceStore, presenceTeam } from './fixtures/presence-groups.ts';

const store = presenceStore();

function operatorPost(text: string) {
	return {
		sender: { kind: 'user' as const, id: 'operator' },
		text,
		replyTo: null,
		source: 'local',
	};
}

test('delivery keeps online members only while running and offline members always', () => {
	const running = (slug: string) => slug === 'ada';
	const human = { kind: 'user' };
	expect(
		groupWakeTargets(
			{ sender: human, groups: { online: ['ada', 'bob'], offline: ['cy', 'gone'] } },
			['ada', 'bob', 'cy'],
			running,
		),
	).toEqual(['ada', 'cy']);
	expect(groupWakeTargets({ sender: human }, ['ada'], running)).toEqual([]);
	// An agent's post never acts on a group, however it was resolved.
	expect(
		groupWakeTargets(
			{ sender: { kind: 'agent' }, groups: { offline: ['cy'] } },
			['cy'],
			running,
		),
	).toEqual([]);
});

test('an agent writing @offline in prose addresses the group but starts nobody', async () => {
	await store.register('ada', 'kilo');
	const h = presenceTeam();
	const post = await appendLocalEvent(
		{
			sender: { kind: 'agent', id: 'roger' },
			text: 'The new @online/@offline tokens collide with member names.',
			replyTo: null,
			source: 'local',
		},
		presence({ ada: 'offline' }).resolve,
	);
	expect(post.groups).toEqual({ online: [], offline: ['ada'] });
	expect(addressedTo(post, 'ada')).toBe(true);
	await h.team.wakeMentions(post);
	expect(h.launched()).toBe(0);
	await h.close();
});

test('a stored group token is the group, never a same-named member, on a new post', async () => {
	// Members may still be registered as online and offline. Each post below stores its group,
	// and neither member is in it: online is definitely offline, offline's presence is unknown.
	await store.register('online', 'kilo');
	await store.register('offline', 'kilo');
	const h = presenceTeam();
	const onlineOnly = await appendLocalEvent(
		operatorPost('@online only'),
		presence({ online: 'offline' }).resolve,
	);
	expect(onlineOnly.groups).toEqual({ online: [] });
	const offlineOnly = await appendLocalEvent(operatorPost('@offline only'), presence({}).resolve);
	expect(offlineOnly.groups).toEqual({ offline: [] });
	for (const post of [onlineOnly, offlineOnly]) {
		await h.team.wakeMentions(post);
		expect(explicitNames(post, ['online', 'offline'])).toEqual([]);
		expect(addressedTo(post, 'online')).toBe(false);
		expect(addressedTo(post, 'offline')).toBe(false);
	}
	expect(h.launched()).toBe(0);
	// Missed-mention recovery reads the same rule.
	const started: string[] = [];
	await recoverMissedMentionWakes(
		[onlineOnly, offlineOnly],
		new Date(Date.now() - 60_000).toISOString(),
		() => false,
		(slug) => {
			started.push(slug);
			return Promise.resolve();
		},
	);
	expect(started).toEqual([]);
	await h.close();
});

test('an event stored without groups keeps the plain name meaning', async () => {
	await store.register('online', 'kilo');
	const legacy = { text: '@online please look' };
	expect(explicitNames(legacy, ['online', 'ada'])).toEqual(['online']);
	expect(addressedTo(legacy, 'online')).toBe(true);
	// The same text with its group stored no longer names the member.
	expect(explicitNames({ ...legacy, groups: { online: [] } }, ['online', 'ada'])).toEqual([]);
	// @all still reaches everyone, group or not.
	expect(explicitNames({ text: '@all and @online', groups: { online: [] } }, ['online'])).toEqual(
		['online'],
	);
});

test('@online never starts a stopped member; @offline starts through the mention path', async () => {
	await store.register('ada', 'kilo');
	await store.register('bob', 'kilo');
	await store.register('hal', 'kilo', true);
	const h = presenceTeam();

	const online = await appendLocalEvent(
		operatorPost('@online quick check'),
		presence({ ada: 'online', bob: 'online' }).resolve,
	);
	expect(online.groups).toEqual({ online: ['ada', 'bob'] });
	// Both went offline before delivery: nobody is started.
	await h.team.wakeMentions(online);
	expect(h.launched()).toBe(0);

	const offline = await appendLocalEvent(
		operatorPost('@offline come in'),
		presence({ ada: 'offline', bob: 'online', hal: 'offline' }).resolve,
	);
	expect(offline.groups).toEqual({ offline: ['ada', 'hal'] });
	await h.team.wakeMentions(offline);
	// Ada starts; the hibernated member is in the group but is still not woken.
	expect(h.launched()).toBe(1);
	expect(h.team.sessions.get('ada')?.agent.status).toBe('running');
	expect(h.team.sessions.get('hal')).toBeUndefined();
	await h.close();
});

test('an explicit name still starts its member next to @online, once', async () => {
	await store.register('bob', 'kilo');
	const h = presenceTeam();
	const event = await appendLocalEvent(
		operatorPost('@online and @bob'),
		presence({ bob: 'online' }).resolve,
	);
	await h.team.wakeMentions(event);
	expect(h.launched()).toBe(1);
	await h.close();
});

test('missed-mention recovery reads the stored groups and starts only offline members', async () => {
	await store.register('jack', 'grok');
	await store.register('kit', 'kilo');
	const since = new Date(Date.now() - 60_000).toISOString();
	const online = await appendLocalEvent(
		operatorPost('@online read this'),
		presence({ jack: 'online', kit: 'online' }).resolve,
	);
	const offline = await appendLocalEvent(
		operatorPost('@offline read this'),
		presence({ jack: 'offline', kit: 'unknown' }).resolve,
	);
	const started: string[] = [];
	await recoverMissedMentionWakes(
		[online, offline],
		since,
		() => false,
		(slug) => {
			started.push(slug);
			return Promise.resolve();
		},
	);
	expect(started).toEqual(['jack']);
});

test('a Telegram post resolves once and its local mirror carries the same groups', async () => {
	await store.register('ada');
	await store.register('bob', 'codex');
	const config = { botToken: '123:fake', chatId: '456', allowedUserIds: ['456'] };
	const { resolve, asked } = presence({ ada: 'online', bob: 'offline' });
	const recorded = await recordRoomEvent(
		config,
		{
			messageId: 10,
			sender: { kind: 'user', id: '456' },
			text: '@online @offline from my phone',
			replyTo: null,
		},
		resolve,
	);
	expect(recorded.groups).toEqual({ online: ['ada'], offline: ['bob'] });
	expect((await roomEvents(config))[0]?.groups).toEqual({ online: ['ada'], offline: ['bob'] });
	expect((await localEvents())[0]?.groups).toEqual({ online: ['ada'], offline: ['bob'] });
	expect(asked).toHaveLength(1);
});
