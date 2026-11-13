import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sendMessage } from '../src/mailbox.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previousHome = process.env.SUMMON_HOME;
const previousAgent = process.env.SUMMON_AGENT;

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	delete process.env.SUMMON_AGENT;
});

afterEach(async () => {
	if (previousHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousHome;
	if (previousAgent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previousAgent;
	await fixture.dispose();
});

function path(folder: 'inbox' | 'archive' | 'delivery' | 'holds', file: string): string {
	return join(fixture.records, 'mailboxes', 'alpha', folder, file);
}

async function mark(id: string, state: 'read' | 'confirmed'): Promise<void> {
	await mkdir(path('delivery', ''), { recursive: true });
	await writeFile(path('delivery', `${id}.${state}`), 'recorded');
}

async function hold(id: string): Promise<void> {
	await mkdir(path('holds', ''), { recursive: true });
	const holdId = crypto.randomUUID();
	await writeFile(
		path('holds', `${holdId}.json`),
		JSON.stringify({
			id: holdId,
			agent: 'alpha',
			messageId: id,
			sender: 'beta',
			reason: 'Keep',
			proposal: 'Wait',
			digest: 'x',
			createdAt: new Date().toISOString(),
			decision: 'pending',
			userReference: '',
		}),
	);
}

interface Preview {
	rows: {
		id: string;
		kind: string;
		read: boolean;
		confirmed: boolean;
		held: boolean;
		disposition: string;
		reason: string;
	}[];
	candidateCount: number;
	plan: string | null;
	next: string | null;
}

async function preview(after?: string): Promise<Preview> {
	const result = await fixture.run(
		['--mail', 'bulk-archive', 'preview', ...(after ? [after] : [])],
		'alpha',
	);
	expect(result.code).toBe(0);
	return JSON.parse(result.out) as Preview;
}

test('only a fully read unheld receipt moves, preserving substantive and uncertain work', async () => {
	const receipt = await sendMessage('beta', 'alpha', 'Old bookkeeping', { kind: 'receipt' });
	const unread = await sendMessage('beta', 'alpha', 'Unseen bookkeeping', { kind: 'receipt' });
	const request = await sendMessage('beta', 'alpha', 'Action still pending');
	const confirmation = await sendMessage('beta', 'alpha', 'Informational confirmation', {
		kind: 'confirmation',
	});
	const exact = await readFile(path('inbox', `${receipt}.md`));
	for (const id of [receipt, request, confirmation]) await mark(id, 'read');
	await mark(request, 'confirmed');
	const page = await preview();
	expect(page.candidateCount).toBe(1);
	expect(page.rows.find((row) => row.id === receipt)?.reason).toBe('read-receipt');
	expect(page.rows.find((row) => row.id === request)?.reason).toBe(
		'confirmation-is-not-handling',
	);
	expect(page.rows.find((row) => row.id === unread)?.reason).toBe('receipt-unread');
	const result = await fixture.run(['--mail', 'bulk-archive', 'apply', page.plan ?? ''], 'alpha');
	expect(result.code).toBe(0);
	expect((JSON.parse(result.out) as { archived: string[] }).archived).toEqual([receipt]);
	expect(await readFile(path('archive', `${receipt}.md`))).toEqual(exact);
	expect(await Bun.file(path('inbox', `${receipt}.md`)).exists()).toBe(false);
	expect(await Bun.file(path('delivery', `${receipt}.read`)).exists()).toBe(true);
	for (const id of [unread, request, confirmation])
		expect(await Bun.file(path('inbox', `${id}.md`)).exists()).toBe(true);
});

test('a hold blocks a read receipt and a changed body invalidates an old plan', async () => {
	const held = await sendMessage('beta', 'alpha', 'Held', { kind: 'receipt' });
	const changed = await sendMessage('beta', 'alpha', 'Original', { kind: 'receipt' });
	await mark(held, 'read');
	await mark(changed, 'read');
	await hold(held);
	const page = await preview();
	expect(page.rows.find((row) => row.id === held)?.reason).toBe('hold-evidence');
	expect(page.candidateCount).toBe(1);
	const original = await readFile(path('inbox', `${changed}.md`), 'utf8');
	await writeFile(path('inbox', `${changed}.md`), original.replace(/\n[^\n]+\n$/, '\nChanged\n'));
	const result = await fixture.run(['--mail', 'bulk-archive', 'apply', page.plan ?? ''], 'alpha');
	expect(result.code).toBe(1);
	expect(result.error).toContain('Bulk archive inputs changed');
	expect(await Bun.file(path('inbox', `${changed}.md`)).exists()).toBe(true);
	expect(await Bun.file(path('inbox', `${held}.md`)).exists()).toBe(true);
});

test('a hold arriving after preview prevents the planned archive', async () => {
	const id = await sendMessage('beta', 'alpha', 'Read', { kind: 'receipt' });
	await mark(id, 'read');
	const page = await preview();
	await hold(id);
	const result = await fixture.run(['--mail', 'bulk-archive', 'apply', page.plan ?? ''], 'alpha');
	expect(result.code).toBe(1);
	expect(result.error).toContain('Bulk archive inputs changed');
	expect(await Bun.file(path('inbox', `${id}.md`)).exists()).toBe(true);
});

test('archive target conflicts stop before replacement', async () => {
	const id = await sendMessage('beta', 'alpha', 'Original', { kind: 'receipt' });
	await mark(id, 'read');
	const page = await preview();
	await mkdir(path('archive', ''), { recursive: true });
	await writeFile(path('archive', `${id}.md`), 'Different retained body');
	const result = await fixture.run(['--mail', 'bulk-archive', 'apply', page.plan ?? ''], 'alpha');
	expect(result.code).toBe(1);
	expect(result.error).toContain('Bulk archive inputs changed');
	expect(await readFile(path('archive', `${id}.md`), 'utf8')).toBe('Different retained body');
	expect(await Bun.file(path('inbox', `${id}.md`)).exists()).toBe(true);
});

test('a changed read marker invalidates the preview without moving the body', async () => {
	const id = await sendMessage('beta', 'alpha', 'Original', { kind: 'receipt' });
	await mark(id, 'read');
	const page = await preview();
	await writeFile(path('delivery', `${id}.read`), 'a different read record');
	const result = await fixture.run(['--mail', 'bulk-archive', 'apply', page.plan ?? ''], 'alpha');
	expect(result.code).toBe(1);
	expect(result.error).toContain('Bulk archive inputs changed');
	expect(await Bun.file(path('inbox', `${id}.md`)).exists()).toBe(true);
});

test('partial batch can restart with a new preview without undoing prior archives', async () => {
	const first = await sendMessage('beta', 'alpha', 'First', { kind: 'receipt' });
	const second = await sendMessage('beta', 'alpha', 'Second', { kind: 'receipt' });
	await mark(first, 'read');
	await mark(second, 'read');
	const page = await preview();
	const selected = page.rows.filter((row) => row.disposition === 'ARCHIVE');
	const later = selected[1]?.id;
	expect(later).toBeDefined();
	const original = await readFile(path('inbox', `${later}.md`), 'utf8');
	await writeFile(path('inbox', `${later}.md`), original.replace(/\n[^\n]+\n$/, '\nChanged\n'));
	const failed = await fixture.run(['--mail', 'bulk-archive', 'apply', page.plan ?? ''], 'alpha');
	expect(failed.code).toBe(1);
	expect(await Bun.file(path('archive', `${selected[0]?.id}.md`)).exists()).toBe(true);
	expect(await Bun.file(path('inbox', `${later}.md`)).exists()).toBe(true);
	const fresh = await preview();
	expect(fresh.candidateCount).toBe(1);
	const resumed = await fixture.run(
		['--mail', 'bulk-archive', 'apply', fresh.plan ?? ''],
		'alpha',
	);
	expect(resumed.code).toBe(0);
	expect(await Bun.file(path('inbox', `${later}.md`)).exists()).toBe(false);
});

test('preview is bounded and keeps malformed entries for investigation', async () => {
	for (let index = 0; index < 21; index++) {
		await sendMessage('beta', 'alpha', `Pending ${index}`);
	}
	const page = await preview();
	expect(page.rows).toHaveLength(20);
	expect(page.next).not.toBeNull();
	expect((await preview(page.next ?? '')).rows).toHaveLength(1);
	const malformed = page.rows[0]?.id;
	expect(malformed).toBeDefined();
	await writeFile(path('inbox', `${malformed}.md`), 'malformed');
	const afterCorruption = await preview();
	expect(afterCorruption.rows.find((row) => row.id === malformed)?.reason).toBe(
		'identity-or-header-unverified',
	);
});

test('a publisher after preview stays outside the batch', async () => {
	const selected = await sendMessage('beta', 'alpha', 'Read', { kind: 'receipt' });
	await mark(selected, 'read');
	const page = await preview();
	const later = await sendMessage('beta', 'alpha', 'New work');
	const result = await fixture.run(['--mail', 'bulk-archive', 'apply', page.plan ?? ''], 'alpha');
	expect(result.code).toBe(0);
	expect(await Bun.file(path('archive', `${selected}.md`)).exists()).toBe(true);
	expect(await Bun.file(path('inbox', `${later}.md`)).exists()).toBe(true);
});
