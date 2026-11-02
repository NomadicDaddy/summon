import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
	claudeInputSubmitted,
	claudeNoticeAllowed,
	claudeTurn,
	claudeTurnEventSchema,
	initializeClaudeTurn,
	invalidateClaudeTurn,
	observeClaudeTurn,
	reserveClaudeNotice,
} from '../src/claude-turn-state.ts';
import { markReady, saveDelivery } from '../src/mail-session.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'native-claude';
let sequence = 0;
type Event = import('zod').infer<typeof claudeTurnEventSchema>;
function event(kind: Event['kind'], turn: string | null = null, draft = false, completed = false) {
	return observeClaudeTurn('alpha', nonce, 'owned-observer', {
		session: 'exact-thread',
		epoch: 1,
		sequence: ++sequence,
		kind,
		turn,
		draft,
		completed,
	});
}
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_NONCE = nonce;
	sequence = 0;
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

test('startup waits for a real main start/completion pair before its first wake', async () => {
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	await event('attach');
	await event('complete', 'old', false, true);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	await event('start', 'one');
	await event('complete', 'one', false, true);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
	await reserveClaudeNotice('alpha', nonce);
	await event('complete', 'one', false, true);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	await event('start', 'two');
	await event('complete', 'two', false, true);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
});

test('initial native turn blocks ordinary notices until its final completion', async () => {
	await event('attach');
	await event('start', 'startup');
	expect(reserveClaudeNotice('alpha', nonce)).rejects.toThrow('verified turn');
	await initializeClaudeTurn('alpha', nonce, 'exact-thread');
	await markReady('alpha', nonce);
	await event('complete', 'startup', false, true);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
	expect(initializeClaudeTurn('alpha', nonce, 'different')).rejects.toThrow('another thread');
});

test('readiness, sidebar status, abort and draft events are not native completion', async () => {
	await markReady('alpha', nonce);
	await event('attach');
	await event('draft');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	await event('start', 'aborted');
	await event('complete', 'aborted');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	await event('start', 'answer');
	await event('complete', 'answer', true, true);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	await event('draft');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
});

test('only definite unsent rollback without newer input can restore idle', async () => {
	await event('attach');
	await event('idle');
	const rollback = await reserveClaudeNotice('alpha', nonce);
	await rollback();
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
	const older = await reserveClaudeNotice('alpha', nonce);
	await claudeInputSubmitted('alpha', nonce);
	await older();
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	await event('attach');
	await event('start', 'one');
	await claudeInputSubmitted('alpha', nonce);
	await event('complete', 'one', false, true);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
});

test('main compaction blocks idle until all observed main compactions settle', async () => {
	await markReady('alpha', nonce);
	await event('attach');
	await event('start', 'one');
	await event('compact-start');
	await event('compact-start');
	await event('complete', 'one', false, true);
	await event('compact-end');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	await event('compact-end');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
	await event('compact-end');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
});

test('gap, replaced observer, duplicate and wrong-session metadata cannot prove idle', async () => {
	await markReady('alpha', nonce);
	await event('attach');
	await event('start', 'one');
	sequence++;
	await event('complete', 'one', false, true);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	await initializeClaudeTurn('alpha', nonce, 'exact-thread', 'new-observer');
	await event('complete', 'one', false, true);
	expect((await claudeTurn('alpha', nonce))?.sequence).toBe(0);
	const metadata = {
		session: 'exact-thread',
		epoch: 2,
		sequence: 1,
		kind: 'attach',
		turn: null,
		draft: false,
		completed: false,
	};
	await observeClaudeTurn('alpha', nonce, 'new-observer', metadata);
	await observeClaudeTurn('alpha', nonce, 'new-observer', metadata);
	expect((await claudeTurn('alpha', nonce))?.sequence).toBe(1);
	expect(
		observeClaudeTurn('alpha', nonce, 'new-observer', { ...metadata, session: 'other' }),
	).rejects.toThrow('another session');
	await invalidateClaudeTurn('alpha', nonce, 'owned-observer');
	expect((await claudeTurn('alpha', nonce))?.attached).toBe(true);
	await invalidateClaudeTurn('alpha', nonce, 'new-observer');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
});

test('new submission defeats previous completion; another main start must be observed', async () => {
	await markReady('alpha', nonce);
	await event('attach');
	await event('start', 'old');
	await event('submit', null, true);
	await event('complete', 'old', false, true);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	await event('start', 'new');
	await event('complete', 'old', false, true);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	await event('complete', 'new', false, true);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
	await event('end', null, true);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
});

test('private payload fields, missing launch, unsafe nonce and corrupted storage fail closed', async () => {
	expect(await claudeNoticeAllowed('alpha', 'missing')).toBe(false);
	expect(initializeClaudeTurn('alpha', '../escape', 'thread', 'observer')).rejects.toThrow(
		'nonce',
	);
	expect(
		observeClaudeTurn('alpha', nonce, 'owned-observer', {
			session: 'exact-thread',
			epoch: 1,
			sequence: 1,
			kind: 'start',
			turn: 'one',
			draft: false,
			completed: false,
			answer: 'PRIVATE_SENTINEL',
		}),
	).rejects.toThrow();
	expect(JSON.stringify(await claudeTurn('alpha', nonce))).not.toContain('PRIVATE');
	await Bun.write(join(fixture.records, `runtime/alpha/${nonce}.claude-turn`), 'PRIVATE_CORRUPT');
	expect(claudeNoticeAllowed('alpha', nonce)).rejects.toThrow('Invalid Claude turn');
});

test('native idle recovers attachment once, never a reserved or submitted turn', async () => {
	await markReady('alpha', nonce);
	await event('attach', null, true);
	await event('idle', null, true);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	await event('idle');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
	await reserveClaudeNotice('alpha', nonce);
	await event('idle');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	await event('attach');
	await claudeInputSubmitted('alpha', nonce);
	await event('idle');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
});

test('idle cannot clear a draft on an existing idle turn or cross a gap, compact or end', async () => {
	await markReady('alpha', nonce);
	await event('attach');
	await event('compact-start');
	await event('idle');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	await event('compact-end');
	await event('idle');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
	await event('draft', null, true);
	await event('idle');
	expect((await claudeTurn('alpha', nonce))?.draft).toBe(true);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	await event('attach');
	sequence++;
	await event('idle');
	await event('idle');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	await event('attach');
	await event('end');
	await event('idle');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
});
