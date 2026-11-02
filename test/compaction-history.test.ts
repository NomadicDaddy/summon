import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CompactionInput } from '../src/compaction-model.ts';

import { startClaudeTurnBridge } from '../src/claude-turn-bridge.ts';
import { claudeTurn } from '../src/claude-turn-state.ts';
import {
	compactionIdentity,
	readCompactions,
	retainCompaction,
} from '../src/compaction-history.ts';
import { retainGrokCompaction } from '../src/compaction-observers.ts';
import { initializeGrokTurn } from '../src/grok-turn-state.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previousHome = process.env.SUMMON_HOME;
const previousGrok = process.env.GROK_SESSION_ID;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previousHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousHome;
	if (previousGrok === undefined) delete process.env.GROK_SESSION_ID;
	else process.env.GROK_SESSION_ID = previousGrok;
	await fixture.dispose();
});

function record(sequence: number): CompactionInput {
	return {
		provider: 'claude',
		nonce: 'history-launch',
		source: 'claude-mod',
		phase: 'start',
		identity: compactionIdentity(['observer', sequence]),
		nativeAt: null,
		deduplication: 'native-id',
	};
}

test('immutable concurrent retention deduplicates identity and pages without altering evidence', async () => {
	expect(
		await Promise.all([
			retainCompaction('alpha', record(1)),
			retainCompaction('alpha', record(1)),
		]),
	).toContain(true);
	await retainCompaction('alpha', record(2));
	const page = await readCompactions('alpha', 1);
	expect(page.retainedObservations).toBe(2);
	expect(page.more).toBe(true);
	expect(page.next).not.toBeNull();
	const next = await readCompactions('alpha', 1, page.next ?? undefined);
	expect(next.entries).toHaveLength(1);
	expect(next.entries[0]?.id).not.toBe(page.entries[0]?.id);
	expect(next.more).toBe(false);
	expect(await retainCompaction('alpha', record(1))).toBe(false);
	expect(
		await retainCompaction('alpha', { ...record(1), phase: 'end' }).catch((error: unknown) =>
			String(error),
		),
	).toContain('identity');
	expect(await retainCompaction('alpha', { ...record(1), nonce: 'resumed-launch' })).toBe(false);
});

test('reader is own-session scoped and performs no initialization; foreign payload keys are rejected', async () => {
	const empty = await fixture.run(['--compactions'], 'alpha');
	expect(empty.code).toBe(0);
	const parsed: unknown = JSON.parse(empty.out);
	expect(parsed).toMatchObject({ retainedObservations: 0 });
	expect(await Bun.file(join(fixture.records, 'compactions')).exists()).toBe(false);
	expect((await fixture.run(['--compactions', '--member', 'beta'], 'alpha')).code).toBe(1);
	expect((await fixture.run(['--compactions', '--limit', '0'], 'alpha')).code).toBe(1);
	const privateInput = { ...record(1), prompt: 'PRIVATE_MUST_NOT_PERSIST' };
	expect(
		await retainCompaction('alpha', privateInput).catch((error: unknown) => error),
	).toBeInstanceOf(Error);
	expect(await Bun.file(join(fixture.records, 'compactions')).exists()).toBe(false);
});

test('damaged existing evidence is retained and refused, never overwritten', async () => {
	await retainCompaction('alpha', record(1));
	const directory = join(fixture.records, 'compactions/alpha');
	const file = (await readdir(directory))[0];
	if (!file) throw new Error('Missing record fixture');
	await writeFile(join(directory, file), 'DAMAGED');
	expect(await readCompactions('alpha', 10).catch((error: unknown) => String(error))).toContain(
		'damaged',
	);
	expect(
		await retainCompaction('alpha', record(1)).catch((error: unknown) => error),
	).toBeInstanceOf(Error);
	expect(await Bun.file(join(directory, file)).text()).toBe('DAMAGED');
});

test('actual Claude bridge retains only accepted compact metadata, not turn/prompt bodies', async () => {
	const bridge = await startClaudeTurnBridge('alpha', 'history-launch', 'exact');
	try {
		for (const [sequence, kind] of [
			[1, 'attach'],
			[2, 'compact-start'],
			[3, 'compact-end'],
		] as const) {
			const response = await fetch(bridge.env.SUMMON_CLAUDE_TURN_URL, {
				method: 'POST',
				headers: { authorization: `Bearer ${bridge.env.SUMMON_CLAUDE_TURN_KEY}` },
				body: JSON.stringify({
					session: 'exact',
					epoch: 1,
					sequence,
					kind,
					turn: null,
					completed: false,
					draft: false,
				}),
			});
			expect(response.status).toBe(204);
		}
		const history = await readCompactions('alpha', 10);
		expect(history.entries.map(({ record: entry }) => entry.phase).sort()).toEqual([
			'end',
			'start',
		]);
		expect(history.entries.every(({ record: entry }) => entry.nativeAt === null)).toBe(true);
		expect(JSON.stringify(history)).not.toContain(bridge.env.SUMMON_CLAUDE_TURN_KEY);
		expect(JSON.stringify(history)).not.toContain('exact');
	} finally {
		await bridge.stop();
	}
});

test('Grok common fields retain phase/time only for exact reserved provider session identity', async () => {
	await initializeGrokTurn('alpha', 'history-launch', 'exact');
	const event = {
		hook_event_name: 'PreCompact',
		sessionId: 'exact',
		timestamp: '2026-10-08T00:00:00.000Z',
		privateContext: 'PRIVATE_MUST_NOT_PERSIST',
	};
	process.env.GROK_SESSION_ID = 'other';
	await retainGrokCompaction('alpha', 'history-launch', event);
	expect((await readCompactions('alpha', 10)).retainedObservations).toBe(0);
	process.env.GROK_SESSION_ID = 'exact';
	await retainGrokCompaction('alpha', 'history-launch', event);
	await retainGrokCompaction('alpha', 'history-launch', event);
	const history = await readCompactions('alpha', 10);
	expect(history.retainedObservations).toBe(1);
	expect(history.entries[0]?.record.nativeAt).toBe(event.timestamp);
	expect(history.entries[0]?.record.deduplication).toBe('metadata-fingerprint');
	expect(JSON.stringify(history)).not.toContain('PRIVATE');
	expect(JSON.stringify(history)).not.toContain('exact');
});

test('Grok rejects timestamps without a zone and unrelated native sessions', async () => {
	await initializeGrokTurn('alpha', 'history-launch', 'exact');
	process.env.GROK_SESSION_ID = 'exact';
	const event = {
		hook_event_name: 'PostCompact',
		sessionId: 'exact',
		timestamp: '2026-10-08T00:00:00.123456789+00:00',
	};
	for (const timestamp of ['2026-10-08T00:00:00', '2026-02-30T00:00:00Z', 'not-a-time'])
		await retainGrokCompaction('alpha', 'history-launch', { ...event, timestamp });
	await retainGrokCompaction('alpha', 'history-launch', { ...event, sessionId: 'other' });
	await retainGrokCompaction('alpha', 'history-launch', { ...event, subagentType: 'child' });
	expect((await readCompactions('alpha', 10)).retainedObservations).toBe(0);
	await retainGrokCompaction('alpha', 'history-launch', event);
	await retainGrokCompaction('alpha', 'history-launch', event);
	const history = await readCompactions('alpha', 10);
	expect(history.retainedObservations).toBe(1);
	expect(history.entries[0]?.record.nativeAt).toBe(event.timestamp);
});

test('unexpected storage shapes fail without deleting user files', async () => {
	await mkdir(join(fixture.records, 'compactions'));
	await writeFile(join(fixture.records, 'compactions/alpha'), 'USER_CONTROL');
	expect(
		await retainCompaction('alpha', record(1)).catch((error: unknown) => String(error)),
	).toContain('unexpected type');
	expect(await Bun.file(join(fixture.records, 'compactions/alpha')).text()).toBe('USER_CONTROL');
});

test('history failure does not withdraw verified Claude completion or expose provider input', async () => {
	await mkdir(join(fixture.records, 'compactions'));
	await writeFile(join(fixture.records, 'compactions/alpha'), 'USER_CONTROL');
	const bridge = await startClaudeTurnBridge('alpha', 'history-launch', 'exact');
	try {
		for (const [sequence, kind] of [
			[1, 'attach'],
			[2, 'compact-start'],
			[3, 'compact-end'],
		] as const) {
			const response = await fetch(bridge.env.SUMMON_CLAUDE_TURN_URL, {
				method: 'POST',
				headers: { authorization: `Bearer ${bridge.env.SUMMON_CLAUDE_TURN_KEY}` },
				body: JSON.stringify({
					session: 'exact',
					epoch: 1,
					sequence,
					kind,
					turn: null,
					completed: false,
					draft: false,
				}),
			});
			expect(response.status).toBe(204);
		}
		expect((await claudeTurn('alpha', 'history-launch'))?.compactions).toBe(0);
		expect((await claudeTurn('alpha', 'history-launch'))?.attached).toBe(true);
		expect(await Bun.file(join(fixture.records, 'compactions/alpha')).text()).toBe(
			'USER_CONTROL',
		);
	} finally {
		await bridge.stop();
	}
});

test('invalid provider/source combinations and oversized records refuse instead of inflating totals', async () => {
	expect(
		await retainCompaction('alpha', { ...record(1), provider: 'kilo' }).catch(
			(error: unknown) => String(error),
		),
	).toContain('provider');
	await retainCompaction('alpha', record(1));
	const directory = join(fixture.records, 'compactions/alpha');
	const file = (await readdir(directory))[0];
	if (!file) throw new Error('Missing history fixture');
	await writeFile(join(directory, file), 'x'.repeat(2049));
	expect(await readCompactions('alpha', 10).catch((error: unknown) => String(error))).toContain(
		'too large',
	);
	expect(Bun.file(join(directory, file)).size).toBe(2049);
});
