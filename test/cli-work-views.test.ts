import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { createBoardItem } from '../src/board.ts';
import { rotateCommittedEvents } from '../src/local-room-storage.ts';
import { type LocalEvent, localRoomPath } from '../src/local-room.ts';
import { sendMessage } from '../src/mailbox.ts';
import { createSchedule, listSchedules } from '../src/schedules.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});
async function snapshot(root = fixture.records): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) Object.assign(files, await snapshot(path));
		else
			files[path] = `${(await stat(path)).mtimeMs}:${createHash('sha256')
				.update(await readFile(path))
				.digest('hex')}`;
	}
	return files;
}

test('room search finds archived originals with bounded pagination and no cursor writes', async () => {
	const events: LocalEvent[] = Array.from({ length: 1200 }, (_, index) => ({
		id: index + 1,
		at: new Date().toISOString(),
		sender: { kind: 'user', id: 'operator' },
		text:
			index === 0
				? `${'İ'.repeat(1000)} Match [literal] 😀`
				: index < 25
					? `Match [literal] ${index} 😀`
					: 'other',
		replyTo: null,
		source: 'local',
	}));
	await mkdir(join(fixture.records, 'room'));
	await writeFile(localRoomPath(), JSON.stringify(events));
	await rotateCommittedEvents(events, 1);
	await writeFile(join(fixture.records, 'AGENTS.md'), 'Do not rewrite this read-only control.');
	const before = await snapshot();
	const result = await fixture.run(['--room', 'search', '[LITERAL]', '--limit', '20'], 'alpha');
	expect(result.code).toBe(0);
	const page = JSON.parse(result.out) as {
		matches: { id: number; snippet: string }[];
		next: number;
	};
	expect(page.matches).toHaveLength(20);
	expect(page.matches[0]?.id).toBe(1);
	expect(page.matches[0]?.snippet).toContain('[literal]');
	expect(page.next).toBe(20);
	const next = JSON.parse(
		(
			await fixture.run(
				['--room', 'search', '[literal]', '--after', String(page.next)],
				'alpha',
			)
		).out,
	) as { matches: unknown[]; next: null };
	expect(next.matches).toHaveLength(5);
	expect(next.next).toBeNull();
	const original = await fixture.run(['--room', 'show', '1'], 'alpha');
	expect(JSON.parse(original.out) as unknown).toMatchObject({ readOnly: true, event: events[0] });
	const absent = await fixture.run(['--room', 'search', 'absent literal'], 'alpha');
	expect(JSON.parse(absent.out) as unknown).toMatchObject({
		matches: [],
		next: null,
		through: 1200,
	});
	for (const args of [
		['show', '0'],
		['show', '1201'],
		['search', 'x', '--limit', '21'],
		['search', 'x', '--after', '1201'],
		['search', 'x', '--limit', '1', '--limit', '2'],
	])
		expect((await fixture.run(['--room', ...args], 'alpha')).code).toBe(1);
	expect(await snapshot()).toEqual(before);
});

test('own work distinguishes unread from unresolved mail and never reads or confirms a checkpoint', async () => {
	await initializeActivity('alpha', 'test-launch');
	await createBoardItem({ title: 'Own active', owner: 'alpha', state: 'doing' });
	await createBoardItem({ title: 'Foreign active', owner: 'beta', state: 'doing' });
	const readId = await sendMessage('beta', 'alpha', 'unresolved but already read');
	await fixture.run(['--mail', 'receive'], 'alpha');
	const unreadId = await sendMessage('beta', 'alpha', 'unread task');
	await sendMessage('beta', 'alpha', 'mechanical unread receipt', { kind: 'receipt' });
	await sendMessage('beta', 'alpha', 'confirmation is not a request', { kind: 'confirmation' });
	await fixture.run(['--checkpoint'], 'alpha');
	await writeFile(join(fixture.records, 'AGENTS.md'), 'Read-only control');
	const before = await snapshot();
	const result = await fixture.run(['--work'], 'alpha');
	expect(result.code).toBe(0);
	const view = JSON.parse(result.out) as {
		cards: { items: { title: string }[] };
		mail: { pending: number; unread: number };
		checkpoint: { phase: string };
		delivery: { readinessConfirmed: boolean };
	};
	expect(view.cards.items.map((item) => item.title)).toEqual(['Own active']);
	expect(view.mail).toMatchObject({ pending: 4, unread: 3, unreadNonReceipts: 2 });
	expect(view.checkpoint.phase).toBe('page');
	expect(view.delivery.readinessConfirmed).toBe(false);
	expect(result.out).not.toContain('unread task');
	expect(result.out).not.toContain('Foreign active');
	expect(await snapshot()).toEqual(before);
	expect(
		await Bun.file(join(fixture.records, `mailboxes/alpha/delivery/${readId}.read`)).exists(),
	).toBe(true);
	expect(
		await Bun.file(join(fixture.records, `mailboxes/alpha/delivery/${unreadId}.read`)).exists(),
	).toBe(false);
	expect((await fixture.run(['--work', 'beta'], 'alpha')).code).toBe(1);
	expect((await fixture.run(['--work'])).code).toBe(1);
});

test('work summaries reject a changed frozen package without touching source state', async () => {
	await fixture.run(['--room', 'send', 'positive frozen control'], 'beta');
	await fixture.run(['--checkpoint'], 'alpha');
	const path = join(fixture.records, 'runtime/alpha/checkpoint-package.json');
	const packet = JSON.parse(await readFile(path, 'utf8')) as { createdAt: string };
	packet.createdAt = 'changed';
	await writeFile(path, JSON.stringify(packet));
	const before = await snapshot();
	const refused = await fixture.run(['--work'], 'alpha');
	expect(refused.code).toBe(1);
	expect(refused.error).toContain('changed or missing');
	expect(await snapshot()).toEqual(before);
});

test('schedule summary identifies unfinished and deferred work without changing rest policy or runs', async () => {
	await initializeActivity('alpha', 'test-launch');
	const own = await createSchedule({
		owner: 'alpha',
		title: 'Own schedule',
		everyMinutes: 60,
		prompt: 'private prompt',
	});
	await createSchedule({
		owner: 'beta',
		title: 'Foreign schedule',
		everyMinutes: 60,
		prompt: 'foreign prompt',
	});
	const state = await listSchedules();
	const schedule = state.schedules.find((item) => item.id === own.id);
	if (!schedule) throw new Error('Missing own schedule control');
	schedule.nextDueAt = 0;
	schedule.deferred = { reason: 'unfinished-run', dueAt: 0, observedAt: Date.now() };
	const id = randomUUID();
	state.runs.push({
		id,
		scheduleId: own.id,
		owner: 'alpha',
		title: 'Own schedule',
		prompt: 'private prompt',
		dueAt: 0,
		updatedAt: Date.now(),
		status: 'uncertain',
	});
	await writeFile(join(fixture.records, 'schedules/state.json'), JSON.stringify(state));
	await writeFile(join(fixture.records, 'AGENTS.md'), 'Read-only control');
	const before = await snapshot();
	const summary = await fixture.run(['--schedule', 'summary'], 'alpha');
	expect(summary.code).toBe(0);
	expect(JSON.parse(summary.out) as unknown).toMatchObject({
		unfinished: [{ id, status: 'uncertain' }],
		due: [{ id: own.id, deferred: { reason: 'unfinished-run' } }],
	});
	expect(summary.out).not.toContain('private prompt');
	expect(summary.out).not.toContain('Foreign schedule');
	expect(await snapshot()).toEqual(before);
	const blocked = await fixture.run(['--rest', 'ready'], 'alpha');
	expect(blocked.code).toBe(1);
	expect(blocked.error).toContain(id);
	expect(blocked.error).toContain('uncertain');
	const resolved = await fixture.run(['--schedule', 'fail', id, 'inspected fixture'], 'alpha');
	expect(resolved.code).toBe(0);
	const due = await fixture.run(['--rest', 'ready'], 'alpha');
	expect(due.code).toBe(1);
	expect(due.error).toContain(own.id);
	expect(due.error).toContain('deferred: unfinished-run');
	expect((await fixture.run(['--schedule', 'pause', own.id], 'alpha')).code).toBe(0);
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
});

test('compact schedules expose truncation counts, paused and future work', async () => {
	const item = await createSchedule({
		owner: 'alpha',
		title: 'Future',
		everyMinutes: 60,
		prompt: 'scope',
	});
	const state = await listSchedules();
	state.schedules = Array.from({ length: 22 }, (_, index) => ({
		...item,
		id: randomUUID(),
		enabled: index !== 21,
		nextDueAt: index === 21 ? 0 : Number.MAX_SAFE_INTEGER,
	}));
	await writeFile(join(fixture.records, 'schedules/state.json'), JSON.stringify(state));
	const result = await fixture.run(['--schedule', 'summary'], 'alpha');
	expect(result.code).toBe(0);
	const summary = JSON.parse(result.out) as { next: { dueLocal: string }[]; paused: unknown[] };
	expect(summary.next).toHaveLength(20);
	expect(summary.paused).toHaveLength(1);
	expect(result.out).toContain('Unrepresentable timestamp');
	expect(JSON.parse(result.out) as unknown).toMatchObject({
		counts: { next: 21, paused: 1, due: 0, unfinished: 0 },
		limitPerSection: 20,
	});
});
