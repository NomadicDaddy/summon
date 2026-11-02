import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
	attachClaudeObserver,
	claudeInputSubmitted,
	claudeNoticeAllowed,
	initializeClaudeTurn,
	invalidateClaudeTurn,
	observeClaudeTurn,
	reserveClaudeNotice,
} from '../src/claude-turn-state.ts';
import { claudeTurnTraceCap } from '../src/claude-turn-trace.ts';
import { markReady, saveDelivery } from '../src/mail-session.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'traced-claude';
let sequence = 0;
const tracePath = (): string => join(fixture.records, `runtime/alpha/${nonce}.claude-turn.trace`);
function event(kind: string, turn: string | null = null, completed = false) {
	return observeClaudeTurn('alpha', nonce, 'owned-observer', {
		session: 'exact-thread',
		epoch: 1,
		sequence: ++sequence,
		kind,
		turn,
		draft: false,
		completed,
	});
}
async function lines(): Promise<Record<string, unknown>[]> {
	return (await Bun.file(tracePath()).text())
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as Record<string, unknown>);
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
	await markReady('alpha', nonce);
});
afterEach(async () => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = oldNonce;
	await fixture.dispose();
});

test('every observation and every Summon-made write leaves one metadata-only line', async () => {
	await event('attach');
	await event('idle');
	const release = await reserveClaudeNotice('alpha', nonce);
	await release();
	await event('start', 'turn-1');
	await event('start', 'turn-1');
	sequence--;
	await event('complete', 'turn-1', true);
	const trace = await lines();
	expect(trace.map((line) => [line.source, line.kind ?? null, line.verdict])).toEqual([
		['initialize', null, 'observer issued at epoch 1'],
		['observe', 'attach', 'applied'],
		['observe', 'idle', 'applied'],
		['notice-reserve', null, 'busy until native start'],
		['notice-restore', null, 'unsent notice rolled back'],
		['observe', 'start', 'applied'],
		['observe', 'start', 'no phase change'],
		['observe', 'complete', 'ignored: repeated sequence'],
	]);
	const allowed = new Set([
		'at',
		'source',
		'kind',
		'epoch',
		'sequence',
		'turn',
		'completed',
		'draft',
		'before',
		'after',
		'verdict',
		'missed',
	]);
	for (const line of trace)
		for (const key of Object.keys(line)) expect(allowed.has(key)).toBe(true);
	expect(await Bun.file(tracePath()).text()).not.toContain('exact-thread');
});

// Hypothesis for #27661, not proof: Carl's 18:30Z sequence. A human Enter while turn-1 runs marks
// the seat busy with no turn; if Claude folds that text into turn-1 with no new start, turn-1's
// completion no longer matches the record, and Claude's idle prompt cannot release a busy seat.
test('a human Enter during a running turn strands the gate, and the trace shows where', async () => {
	await event('attach');
	await event('start', 'turn-1');
	await claudeInputSubmitted('alpha', nonce);
	await event('complete', 'turn-1', true);
	await event('idle');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	const trace = await lines();
	expect(trace.slice(-3).map((line) => [line.source, line.kind ?? null, line.verdict])).toEqual([
		['human-submit', null, 'busy until native start'],
		['observe', 'complete', 'ignored: completion for a turn the record does not hold'],
		[
			'observe',
			'idle',
			'ignored: idle needs phase unknown, no turn, no draft and no compaction',
		],
	]);
	expect(trace.at(-2)?.before).toMatchObject({ phase: 'busy', turn: null, attached: true });
});

test('launch, attachment and invalidation writes are traced with their epochs', async () => {
	expect(await attachClaudeObserver('alpha', nonce, 'owned-observer', 'exact-thread')).toBe(2);
	await invalidateClaudeTurn('alpha', nonce, 'owned-observer');
	const trace = await lines();
	expect(trace.map((line) => [line.source, line.verdict])).toEqual([
		['initialize', 'observer issued at epoch 1'],
		['attach-observer', 'attached at epoch 2'],
		['invalidate', 'observation lost; detached until reattached'],
	]);
	expect(trace[1]?.after).toMatchObject({ epoch: 2, attached: true, phase: 'unknown' });
	expect(trace[2]?.before).toMatchObject({ epoch: 2, attached: true });
	expect(trace[2]?.after).toMatchObject({ epoch: 2, attached: false, draft: true });
});

test('a refused trace write is counted on the next line written', async () => {
	await rm(tracePath());
	await mkdir(tracePath());
	await event('attach');
	await rm(tracePath(), { recursive: true });
	await event('idle');
	const trace = await lines();
	expect(trace).toHaveLength(1);
	expect(trace[0]).toMatchObject({ kind: 'idle', missed: 1 });
});

test('the trace stops at its cap with exactly one line saying so', async () => {
	await Bun.write(tracePath(), `${'x'.repeat(claudeTurnTraceCap - 100)}\n`);
	await event('attach');
	await event('idle');
	await event('start', 'turn-1');
	const tail = (await Bun.file(tracePath()).text()).split('\n').slice(1).filter(Boolean);
	expect(tail).toHaveLength(1);
	expect(tail[0]).toContain('trace cap of');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
});
