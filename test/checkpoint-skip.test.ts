import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SkipPlan } from '../src/checkpoint-skip-model.ts';

import { initializeActivity } from '../src/agent-activity.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { mailboxPrompt, sendMessage } from '../src/mailbox.ts';
import { newRecord, providers } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previousHome = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previousHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousHome;
	await fixture.dispose();
});

interface Preview {
	catchUp: {
		id: string;
		applied: boolean;
		addressedCount: number;
		entries: { source: string; id: string; snippet: string }[];
		skipped: { room: { from: number; through: number; count: number } };
		next: string | null;
	};
}

async function run(args: string[]) {
	const result = await fixture.run(['--checkpoint', 'catch-up', ...args], 'alpha');
	expect({ code: result.code, error: result.error }).toEqual({ code: 0, error: '' });
	expect(Buffer.byteLength(result.out)).toBeLessThan(30_000);
	return JSON.parse(result.out) as Preview;
}
async function post(text: string, sender = 'beta', replyTo: number | null = null) {
	return appendLocalEvent({
		sender: { kind: 'agent', id: sender },
		text,
		replyTo,
		source: 'local',
	});
}
async function history() {
	const own = await post('Question with exact context', 'alpha');
	const reply = await post('Reply to your question without a mention', 'beta', own.id);
	await post('> @alpha quoted example');
	for (let index = 0; index < 45; index++) await post(`Routine ${index} ${'x'.repeat(1100)}`);
	return { own, reply };
}
async function readPlan(id: string): Promise<SkipPlan> {
	return (
		JSON.parse(await fixture.read(`runtime/alpha/checkpoint-skips/${id}.json`)) as {
			plan: SkipPlan;
		}
	).plan;
}

for (const provider of providers) {
	test(`${provider}: catch-up indexes addressed history, preserves unread mail and supersedes old receipts`, async () => {
		await writeFile(
			join(fixture.records, 'alpha.json'),
			JSON.stringify(newRecord('alpha', fixture.root, provider)),
		);
		const startup = await mailboxPrompt('alpha');
		expect(startup).toContain('An applicable operator hold needs its explicit release');
		expect(startup).toContain('you may leave a historical read-only continuation unfinished');
		// The catch-up threshold is concrete in both startup passages (#24035).
		expect(startup).toContain(
			'When your checkpoint package has more than 5 pages or more than 200 items',
		);
		expect(startup).toContain(
			'When a package has more than 5 pages or more than 200 items (the package.pages and package.items a checkpoint page reports), use summon --checkpoint catch-up instead of paging.',
		);
		expect(startup).not.toContain('deep old-history backlog');
		expect(startup).not.toContain('deep routine-history backlog');
		expect(startup.indexOf('When your checkpoint package has more than 5 pages')).toBeLessThan(
			startup.indexOf('Then run summon --checkpoint.'),
		);
		const { own, reply } = await history();
		const mail = await sendMessage('beta', 'alpha', 'Pending direct work; never skipped');
		const first = await fixture.run(['--checkpoint'], 'alpha');
		expect(first.code).toBe(0);
		const receipt = (JSON.parse(first.out) as { receipt: string }).receipt;
		const frozen = JSON.parse(await fixture.read('runtime/alpha/checkpoint-package.json')) as {
			id: string;
		};
		const before = await fixture.read('runtime/alpha/checkpoint.json');
		const preview = await run([]);
		expect(JSON.stringify(preview)).toContain(
			'An applicable operator hold needs its explicit release',
		);
		const { id, skipped } = preview.catchUp;
		expect(preview.catchUp.applied).toBe(false);
		expect(skipped.room.count).toBeGreaterThan(0);
		expect(preview.catchUp.entries.some((entry) => entry.id === String(reply.id))).toBe(true);
		expect(
			preview.catchUp.entries.some((entry) => entry.snippet.includes('quoted example')),
		).toBe(false);
		expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(before);
		expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(
			false,
		);
		const readMarker = join(fixture.records, 'mailboxes/alpha/delivery', `${mail}.read`);
		expect(await Bun.file(readMarker).exists()).toBe(false);
		const shown = await fixture.run(
			['--checkpoint', 'catch-up', 'show', id, 'room', String(own.id)],
			'alpha',
		);
		expect(shown.code).toBe(0);
		expect(shown.out).toContain('Question with exact context');
		const arrival = await post('@alpha arrived after preview');
		const applied = await run(['apply', id]);
		expect(applied.catchUp.applied).toBe(true);
		const state = JSON.parse(await fixture.read('runtime/alpha/checkpoint.json')) as {
			completedPackage?: string;
			supersededPackage?: string;
		};
		expect(state.supersededPackage).toBe(frozen.id);
		expect(state.completedPackage).toBeUndefined();
		const snapshot = await fixture.run(['--work'], 'alpha');
		expect(snapshot.code).toBe(0);
		expect(snapshot.out).toContain('An applicable operator hold needs its explicit release');
		expect(
			(JSON.parse(snapshot.out) as { checkpoint: { phase: string } }).checkpoint.phase,
		).toBe('no-active-package');
		expect(await fixture.read('runtime/alpha/room.cursor')).toBe(String(skipped.room.through));
		expect(await Bun.file(readMarker).exists()).toBe(false);
		expect(
			await Bun.file(join(fixture.records, 'mailboxes/alpha/inbox', `${mail}.md`)).exists(),
		).toBe(true);
		expect((await fixture.run(['--checkpoint', receipt], 'alpha')).code).toBe(1);
		expect((await run(['apply', id])).catchUp.applied).toBe(true);
		const current = await fixture.run(['--current-requests'], 'alpha');
		expect(current.out).toContain('An applicable operator hold needs its explicit release');
		expect(current.out).toContain(arrival.text);
		const next = await fixture.run(['--checkpoint'], 'alpha');
		expect(next.code).toBe(0);
		expect(next.out).not.toContain('Reply to your question without a mention');
		expect(await Bun.file(readMarker).exists()).toBe(false);
		const resumedState = await fixture.read('runtime/alpha/checkpoint.json');
		await run(['apply', id]);
		expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(resumedState);
		expect(await readFile(fixture.capture, 'utf8')).toBe('');
	}, 20_000);
}

test('a pending apply blocks checkpoint/rest and resumes after an ordinary live lock releases', async () => {
	await initializeActivity('alpha', 'test-launch');
	await history();
	const preview = await run([]);
	const id = preview.catchUp.id;
	const lock = join(fixture.records, 'runtime/alpha/room.cursor.lock');
	await mkdir(join(fixture.records, 'runtime/alpha'), { recursive: true });
	await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
	const failed = await fixture.run(['--checkpoint', 'catch-up', 'apply', id], 'alpha');
	expect(failed.code).toBe(1);
	expect(failed.error).toContain('Mailbox operation is locked');
	expect((await fixture.run(['--checkpoint'], 'alpha')).error).toContain('is incomplete');
	for (const state of ['idle', 'needs-user']) {
		expect((await fixture.run(['--status', state, 'Unchanged wait'], 'alpha')).code).toBe(0);
		const activity = await fixture.read('runtime/alpha/activity.json');
		const resting = await fixture.run(['--rest', 'ready'], 'alpha');
		expect(resting.code).toBe(1);
		expect(resting.error).toContain('catch-up is incomplete');
		expect(await fixture.read('runtime/alpha/activity.json')).toBe(activity);
	}
	await unlink(lock);
	expect((await run(['apply', id])).catchUp.applied).toBe(true);
	expect((await fixture.run(['--checkpoint'], 'alpha')).code).toBe(0);
}, 15_000);

test('completion marker recovery clears an interrupted final progress write without advancing again', async () => {
	await history();
	const preview = await run([]);
	const id = preview.catchUp.id;
	await run(['apply', id]);
	const cursor = await fixture.read('runtime/alpha/room.cursor');
	const path = join(fixture.records, 'runtime/alpha/checkpoint-catch-up.json');
	const progress = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
	await writeFile(path, JSON.stringify({ ...progress, phase: 'applying' }));
	expect((await fixture.run(['--checkpoint'], 'alpha')).code).toBe(1);
	await run(['apply', id]);
	expect(await fixture.read('runtime/alpha/room.cursor')).toBe(cursor);
	expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ phase: 'applied' });
});

test('an intervening real checkpoint acknowledgment invalidates a preview', async () => {
	await history();
	const first = await fixture.run(['--checkpoint'], 'alpha');
	const { receipt } = JSON.parse(first.out) as { receipt: string };
	const preview = await run([]);
	expect((await fixture.run(['--checkpoint', receipt], 'alpha')).code).toBe(0);
	const before = await fixture.read('runtime/alpha/checkpoint.json');
	const refusal = await fixture.run(
		['--checkpoint', 'catch-up', 'apply', preview.catchUp.id],
		'alpha',
	);
	expect(refusal.error).toContain('Checkpoint changed after the preview');
	expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(before);
	expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(false);
});

test('bounded addressed indexes preserve every entry and exact Unicode originals', async () => {
	for (let index = 0; index < 140; index++) await post(`@alpha ${index} ${'界😀'.repeat(40)}`);
	await history();
	const preview = await run([]);
	const id = preview.catchUp.id;
	let page = preview;
	const ids: string[] = [];
	for (;;) {
		ids.push(...page.catchUp.entries.map((entry) => entry.id));
		if (!page.catchUp.next) break;
		page = await run(['list', id, page.catchUp.next]);
	}
	expect(new Set(ids).size).toBe(preview.catchUp.addressedCount);
	expect(ids.length).toBeGreaterThanOrEqual(140);
	const plan = await readPlan(id);
	expect(plan.references.find((entry) => entry.id === '1')?.body).toContain('界😀');
	expect(
		(await fixture.run(['--checkpoint', 'catch-up', 'show', id, 'room', '1', '1.2'], 'alpha'))
			.code,
	).toBe(1);
});

test('invalid options, missing plans and a tail with nothing to skip leave cursors untouched', async () => {
	await post('Only recent history');
	for (const args of [
		['--keep-pages', '0'],
		['--keep-pages', '4'],
		['apply', '../beta'],
	])
		expect((await fixture.run(['--checkpoint', 'catch-up', ...args], 'alpha')).code).toBe(1);
	const preview = await run([]);
	expect(
		(await fixture.run(['--checkpoint', 'catch-up', 'apply', preview.catchUp.id], 'alpha'))
			.code,
	).toBe(1);
	expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(false);
});
