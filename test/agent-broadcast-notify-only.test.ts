import { afterEach, beforeEach, expect, test } from 'bun:test';

import { initializeActivity } from '../src/agent-activity.ts';
import { tickRest } from '../src/desktop/rest.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { readRest, refreshRest, stopForRest } from '../src/rest.ts';
import { addressedTo, startableNames } from '../src/room-wake.ts';
import { loadAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { presenceTeam } from './fixtures/presence-groups.ts';

// Phillip #21677 on #21376: an agent's @all notifies running members but starts and resumes
// nobody; a human or CLI @all starts everyone, and an agent's explicit name still starts that one.

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

async function stopAlphaForRest(): Promise<void> {
	const record = await loadAgent('alpha');
	if (!record) throw new Error('Missing fixture member');
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
	const ready = await readRest('alpha');
	if (!ready) throw new Error('Missing rest confirmation');
	await stopForRest('alpha', ready.id, () => Promise.resolve(), record.provider);
	expect((await readRest('alpha'))?.mode).toBe('stopped');
}

const senders = {
	agent: { kind: 'agent', id: 'roger' },
	user: { kind: 'user', id: 'operator' },
	cli: { kind: 'cli', id: 'CLI' },
} as const;

function post(kind: keyof typeof senders, text: string) {
	return appendLocalEvent({
		sender: senders[kind],
		text,
		replyTo: null,
		source: 'local',
	});
}

test('only a human or CLI @all expands to everyone in the start set', () => {
	const slugs = ['alpha', 'beta'];
	const event = { text: 'Heads up @all.' };
	expect(startableNames({ ...event, sender: { kind: 'agent', id: 'roger' } }, slugs)).toEqual([]);
	expect(startableNames({ ...event, sender: { kind: 'user', id: 'operator' } }, slugs)).toEqual(
		slugs,
	);
	expect(startableNames({ ...event, sender: { kind: 'cli', id: 'CLI' } }, slugs)).toEqual(slugs);
	expect(
		startableNames(
			{ text: '@all and @beta, please.', sender: { kind: 'agent', id: 'roger' } },
			slugs,
		),
	).toEqual(['beta']);
});

test("an agent's @all addresses a member but starts no stopped seat", async () => {
	const event = await post('agent', 'Status for @all: the queue is open.');
	expect(addressedTo(event, 'alpha')).toBe(true);
	const h = presenceTeam();
	await h.team.wakeMentions(event);
	expect(h.launched()).toBe(0);
	await h.close();
});

test("an agent's @all neither resumes nor starts a rest-stopped seat", async () => {
	await stopAlphaForRest();
	const event = await post('agent', 'Status for @all: the queue is open.');
	expect(addressedTo(event, 'alpha')).toBe(true);
	expect((await refreshRest('alpha'))?.mode).toBe('stopped');
	const h = presenceTeam();
	await h.team.wakeMentions(event);
	await tickRest(h.team);
	await tickRest(h.team);
	expect(h.launched()).toBe(0);
	expect((await readRest('alpha'))?.mode).toBe('stopped');
	await h.close();
});

test.each([
	{
		who: 'a human @all',
		kind: 'user' as const,
		text: 'Everyone, @all, please check in.',
		starts: 2,
	},
	{ who: 'a CLI @all', kind: 'cli' as const, text: '@all: queue reopened.', starts: 2 },
	{
		who: "an agent's @all beside @alpha",
		kind: 'agent' as const,
		text: '@all, and @alpha first.',
		starts: 1,
	},
	{ who: 'a human @all in punctuation', kind: 'user' as const, text: 'Note (@all).', starts: 2 },
	{
		who: "an agent's code-quoted @all",
		kind: 'agent' as const,
		text: 'Write `@all` sparingly.',
		starts: 0,
	},
])('$who starts $starts stopped seat(s)', async ({ kind, text, starts }) => {
	const h = presenceTeam();
	await h.team.wakeMentions(await post(kind, text));
	expect(h.launched()).toBe(starts);
	await h.close();
});

test("addressing is unchanged: an agent's plain @all addresses, a quoted one does not", async () => {
	expect(addressedTo(await post('agent', 'Status for @all.'), 'alpha')).toBe(true);
	expect(addressedTo(await post('agent', 'Write `@all` sparingly.'), 'alpha')).toBe(false);
	expect(addressedTo(await post('agent', '> @all is the broadcast token.'), 'alpha')).toBe(false);
});

test.each([
	{ who: 'a human @all', kind: 'user' as const, text: 'Everyone, @all, please check in.' },
	{
		who: "an agent's explicit name",
		kind: 'agent' as const,
		text: '@alpha your review, please.',
	},
])('$who still resumes a rest-stopped seat', async ({ kind, text }) => {
	await stopAlphaForRest();
	await post(kind, text);
	const state = await refreshRest('alpha');
	expect(state?.mode).toBe('wake-requested');
	expect(state?.resume).toBe(true);
	const h = presenceTeam();
	await tickRest(h.team);
	expect(h.launched()).toBe(1);
	await h.close();
});
