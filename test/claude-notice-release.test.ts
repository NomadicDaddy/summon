import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';

import { releaseWithheldClaudeNotice, spendClaudeRelease } from '../src/claude-notice-release.ts';
import { withoutRelease } from '../src/claude-release-token.ts';
import {
	attachClaudeObserver,
	claudeInputSubmitted,
	claudeNoticeAllowed,
	claudeTurn,
	claudeTurnEventSchema,
	initializeClaudeTurn,
	invalidateClaudeTurn,
	observeClaudeTurn,
	pathFor,
	reserveClaudeNotice,
} from '../src/claude-turn-state.ts';
import { saveDelivery } from '../src/mail-session.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'native-claude';
let sequence = 0;
let epoch = 1;
type Event = import('zod').infer<typeof claudeTurnEventSchema>;
function event(kind: Event['kind'], turn: string | null = null, draft = false, completed = false) {
	return observeClaudeTurn('alpha', nonce, 'owned-observer', {
		session: 'exact-thread',
		epoch,
		sequence: ++sequence,
		kind,
		turn,
		draft,
		completed,
	});
}
const allowed = () => claudeNoticeAllowed('alpha', nonce);
const release = (token: string) => releaseWithheldClaudeNotice('alpha', nonce, token);
/** The terminal receiver's reserve: the only caller that mints a release token. */
async function reserve() {
	const reserved = await reserveClaudeNotice('alpha', nonce, true);
	if (!reserved.token) throw new Error('The terminal reserve should mint a token.');
	return Object.assign(reserved, { token: reserved.token });
}
async function idleSeat(): Promise<void> {
	await event('attach');
	await event('idle');
	expect(await allowed()).toBe(true);
}
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_NONCE = nonce;
	sequence = 0;
	epoch = 1;
	await initializeClaudeTurn('alpha', nonce, 'exact-thread', 'owned-observer');
	await saveDelivery('alpha', {
		nonce,
		thread: 'exact-thread',
		pid: process.pid,
		state: 'unconfirmed',
		reason: '',
	});
});
afterEach(async () => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = oldNonce;
	await fixture.dispose();
});

test('a withheld Enter whose text Claude saw and cleared releases once, keeping the record', async () => {
	await idleSeat();
	const { token } = await reserve();
	await event('draft', null, true);
	await event('draft', null, false);
	const before = await claudeTurn('alpha', nonce);
	expect(await release(token)).toEqual({ draft: false });
	const after = await claudeTurn('alpha', nonce);
	expect(after).toMatchObject({ phase: 'idle', turn: null, draft: false });
	expect(after?.release).toBeUndefined();
	expect(after?.sequence).toBe(before?.sequence);
	expect(after?.epoch).toBe(before?.epoch);
	expect(after?.observer).toBe(before?.observer);
	expect(after?.generation).toBe((before?.generation ?? 0) + 1);
	expect(await allowed()).toBe(true);
	expect(await release(token)).toBe(false);
});

test('before any draft report the box is assumed full until Claude reports it empty', async () => {
	await idleSeat();
	const { token } = await reserve();
	expect(await release(token)).toEqual({ draft: true });
	expect(await claudeTurn('alpha', nonce)).toMatchObject({ phase: 'idle', draft: true });
	expect(await allowed()).toBe(false);
	await event('draft', null, true);
	expect(await allowed()).toBe(false);
	expect(reserveClaudeNotice('alpha', nonce)).rejects.toThrow('clear draft');
	await event('draft', null, false);
	expect(await allowed()).toBe(true);
});

test('later text cancels an earlier empty report, and current text is never cleared', async () => {
	await idleSeat();
	const first = await reserve();
	await event('draft', null, true);
	await event('draft', null, false);
	await event('draft', null, true);
	expect(await release(first.token)).toEqual({ draft: true });
	expect(await claudeTurn('alpha', nonce)).toMatchObject({ phase: 'idle', draft: true });
	expect(await allowed()).toBe(false);
	await event('draft', null, false);
	const second = await reserve();
	await event('draft', null, false);
	expect(await release(second.token)).toEqual({ draft: true });
	expect(await claudeTurn('alpha', nonce)).toMatchObject({ draft: true });
});

test('an older token never authorizes a newer reservation, even after a rollback', async () => {
	await idleSeat();
	const older = await reserve();
	await older();
	expect(await allowed()).toBe(true);
	const newer = await reserve();
	expect(newer.token).not.toBe(older.token);
	expect(await release(older.token)).toBe(false);
	expect(await claudeTurn('alpha', nonce)).toMatchObject({ phase: 'busy', turn: null });
	expect(await release(newer.token)).toEqual({ draft: true });
});

const spenders: [string, () => Promise<unknown>][] = [
	['native submit', () => event('submit', 'one')],
	['native start', () => event('start', 'one')],
	['native complete', () => event('complete', 'one', false, true)],
	['native attach', () => event('attach')],
	['native end', () => event('end')],
	['native unknown', () => event('unknown')],
	['native compaction', () => event('compact-start')],
	['native compaction end', () => event('compact-end')],
	['human submit', () => claudeInputSubmitted('alpha', nonce)],
	['invalidation', () => invalidateClaudeTurn('alpha', nonce, 'owned-observer')],
	['coalesced human input', () => spendClaudeRelease('alpha', nonce)],
	[
		'an out-of-order observation',
		() =>
			observeClaudeTurn('alpha', nonce, 'owned-observer', {
				session: 'exact-thread',
				epoch,
				sequence: (sequence += 2),
				kind: 'draft',
				turn: null,
				draft: false,
				completed: false,
			}),
	],
	[
		'a new attachment epoch',
		async () => {
			epoch = await attachClaudeObserver('alpha', nonce, 'owned-observer', 'exact-thread');
		},
	],
];

for (const [name, spend] of spenders)
	test(`${name} spends the token, so the release refuses`, async () => {
		await idleSeat();
		const { token } = await reserve();
		await spend();
		const before = await claudeTurn('alpha', nonce);
		expect(before?.release).toBeUndefined();
		expect(await release(token)).toBe(false);
		expect(await claudeTurn('alpha', nonce)).toEqual(before);
	});

test('native draft and idle reports keep the token; a missing record is never recreated', async () => {
	await idleSeat();
	const { token } = await reserve();
	await event('idle');
	await event('draft', null, true);
	expect((await claudeTurn('alpha', nonce))?.release?.token).toBe(token);
	await rm(pathFor('alpha', nonce));
	expect(await release(token)).toBe(false);
	expect(await claudeTurn('alpha', nonce)).toBeUndefined();
});

test('a busy record written without a token, as older builds write it, never releases', async () => {
	await idleSeat();
	await reserve();
	const current = await claudeTurn('alpha', nonce);
	if (!current?.release) throw new Error('The reservation should carry a token.');
	await Bun.write(pathFor('alpha', nonce), JSON.stringify(withoutRelease(current)));
	expect(await claudeTurn('alpha', nonce)).toMatchObject({ phase: 'busy', turn: null });
	expect(await release(crypto.randomUUID())).toBe(false);
	expect(await claudeTurn('alpha', nonce)).toMatchObject({ phase: 'busy' });
});

test('the default reserve, used by the live channel, writes no token an older reader would refuse', async () => {
	await idleSeat();
	const reserved = await reserveClaudeNotice('alpha', nonce);
	expect(reserved.token).toBeUndefined();
	const raw: unknown = JSON.parse(await Bun.file(pathFor('alpha', nonce)).text());
	expect(Object.keys(raw as object)).not.toContain('release');
	expect(await claudeTurn('alpha', nonce)).toMatchObject({ phase: 'busy', turn: null });
	expect(await release(crypto.randomUUID())).toBe(false);
});

for (const changed of [{ nonce: 'other-launch' }, { observer: 'other-observer' }, { epoch: 2 }])
	test(`a mismatched release binding ${JSON.stringify(changed)} never releases`, async () => {
		await idleSeat();
		const { token } = await reserve();
		const state = await claudeTurn('alpha', nonce);
		if (!state?.release) throw new Error('Missing reservation.');
		const changedState = { ...state, release: { ...state.release, ...changed } };
		await Bun.write(pathFor('alpha', nonce), JSON.stringify(changedState));
		expect(await release(token)).toBe(false);
		expect(await claudeTurn('alpha', nonce)).toEqual(changedState);
	});
