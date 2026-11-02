import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { recoverMissedMentionWakes } from '../src/desktop/mention-recovery.ts';
import { tickRest } from '../src/desktop/rest.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { readRest, refreshRest, stopForRest } from '../src/rest.ts';
import { startableNames } from '../src/room-wake.ts';
import { loadAgent, newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { presenceTeam } from './fixtures/presence-groups.ts';

// Roger M1 and Morticia I1/I2 on 9b871ec (Morgan 80286d7d): a quoted @name or @all is an example,
// not a mention, on every start path, as addressableText already makes it for addressing.

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

const senders = {
	agent: { kind: 'agent', id: 'roger' },
	user: { kind: 'user', id: 'operator' },
	cli: { kind: 'cli', id: 'CLI' },
} as const;
type Kind = keyof typeof senders;

function post(kind: Kind, text: string) {
	return appendLocalEvent({ sender: senders[kind], text, replyTo: null, source: 'local' });
}

// Every quote form addressableText recognises, around a member name and around the broadcast.
const forms = {
	'inline code': (token: string) => `write \`${token}\` like this.`,
	fenced: (token: string) => `Example:\n\`\`\`\n${token}\n\`\`\``,
	'double-quoted': (token: string) => `type "${token}" to call them.`,
	blockquoted: (token: string) => `> ${token} said this earlier.`,
} as const;
type Form = keyof typeof forms;

const QUOTED: { who: string; kind: Kind; text: string }[] = [
	// An agent's broadcast is notify-only already; a quoted name beside it must not start anyone.
	...Object.entries(forms).map(([form, quote]) => ({
		who: `an agent's @all beside a ${form} name`,
		kind: 'agent' as const,
		// Its own line, so a blockquote starts the line as addressableText requires.
		text: `@all, for example:\n${quote('@alpha')}`,
	})),
	...Object.entries(forms).map(([form, quote]) => ({
		who: `an agent's ${form} name alone`,
		kind: 'agent' as const,
		text: quote('@alpha'),
	})),
	// A human or CLI broadcast starts everyone, so a quoted one is the case that matters most.
	...(['user', 'cli'] as const).flatMap((kind) =>
		(Object.keys(forms) as Form[]).map((form) => ({
			who: `a ${kind} ${form} @all`,
			kind,
			text: forms[form]('@all'),
		})),
	),
];

const REAL: { who: string; kind: Kind; text: string; starts: string[] }[] = [
	{
		who: "an agent's real name beside a quoted one",
		kind: 'agent',
		text: '@alpha: write `@beta` like this.',
		starts: ['alpha'],
	},
	{
		who: "an agent's real name beside a quoted @all",
		kind: 'agent',
		text: '@beta, the token is `@all`.',
		starts: ['beta'],
	},
	{
		who: "a human's real @all beside a quoted name",
		kind: 'user',
		text: '@all, note `@alpha`.',
		starts: ['alpha', 'beta'],
	},
	{
		who: "a CLI's real @all",
		kind: 'cli',
		text: '@all: queue reopened.',
		starts: ['alpha', 'beta'],
	},
	{ who: "an agent's real @all alone", kind: 'agent', text: '@all: queue reopened.', starts: [] },
];

test.each(QUOTED)('selection: $who starts nobody', ({ kind, text }) => {
	expect(startableNames({ text, sender: senders[kind] }, ['alpha', 'beta'])).toEqual([]);
});

test.each(REAL)('selection: $who starts only its real mentions', ({ kind, text, starts }) => {
	expect(startableNames({ text, sender: senders[kind] }, ['alpha', 'beta'])).toEqual(starts);
});

test.each(QUOTED)('mention start: $who starts no stopped seat', async ({ kind, text }) => {
	const h = presenceTeam();
	await h.team.wakeMentions(await post(kind, text));
	expect(h.launched()).toBe(0);
	await h.close();
});

test.each(REAL)('mention start: $who starts its real mentions', async ({ kind, text, starts }) => {
	const h = presenceTeam();
	await h.team.wakeMentions(await post(kind, text));
	expect(h.launched()).toBe(starts.length);
	await h.close();
});

async function recovered(kind: Kind, text: string): Promise<string[]> {
	// Recovery acts only for Grok and Kilo seats, so the members here are Kilo.
	for (const slug of ['kit', 'kay']) {
		const record = newRecord(slug, fixture.root, 'kilo');
		await writeFile(join(fixture.records, `${slug}.json`), JSON.stringify(record));
	}
	const since = new Date(Date.now() - 60_000).toISOString();
	const event = await post(kind, text);
	const started: string[] = [];
	await recoverMissedMentionWakes(
		[event],
		since,
		() => false,
		(slug) => {
			started.push(slug);
			return Promise.resolve();
		},
	);
	return started.sort();
}

test.each(
	(['user', 'cli'] as const).flatMap((kind) =>
		(Object.keys(forms) as Form[]).flatMap((form) => [
			{ kind, form, token: '@all' },
			{ kind, form, token: '@kit' },
		]),
	),
)('missed-mention recovery: a $kind $form $token starts nobody', async ({ kind, form, token }) => {
	expect(await recovered(kind, forms[form](token))).toEqual([]);
});

test('missed-mention recovery: a real name beside a quoted @all starts only that name', async () => {
	expect(await recovered('user', '@kit, the token is `@all`.')).toEqual(['kit']);
});

test('missed-mention recovery: a real human @all still starts every Kilo seat', async () => {
	expect(await recovered('user', '@all: queue reopened.')).toEqual(['kay', 'kit']);
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

test.each([
	{
		who: "a human's double-quoted name",
		kind: 'user' as const,
		text: 'Type "@alpha" to call them.',
	},
	{ who: "a human's code-quoted @all", kind: 'user' as const, text: 'The token is `@all`.' },
])('rest resume: $who neither resumes nor starts a rest-stopped seat', async ({ kind, text }) => {
	await stopAlphaForRest();
	await post(kind, text);
	expect((await refreshRest('alpha'))?.mode).toBe('stopped');
	const h = presenceTeam();
	await tickRest(h.team);
	expect(h.launched()).toBe(0);
	await h.close();
});

test("rest resume: a human's real name still resumes the rest-stopped seat", async () => {
	await stopAlphaForRest();
	await post('user', '@alpha your review, please. Not `@beta`.');
	expect((await refreshRest('alpha'))?.mode).toBe('wake-requested');
	const h = presenceTeam();
	await tickRest(h.team);
	expect(h.launched()).toBe(1);
	await h.close();
});
