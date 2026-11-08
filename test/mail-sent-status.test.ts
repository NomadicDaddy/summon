import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
beforeEach(async () => {
	fixture = await mailHarness();
});
afterEach(async () => {
	await fixture.dispose();
});

async function send(): Promise<string> {
	const result = await fixture.run(['--mail', 'send-self', 'beta', 'Please read this.'], 'alpha');
	expect(result.code).toBe(0);
	return (JSON.parse(result.out) as { id: string }).id;
}

async function status(agent: string, id: string) {
	const result = await fixture.run(['--mail', 'sent-status', id], agent);
	expect(result.code).toBe(0);
	return JSON.parse(result.out) as {
		id: string;
		status: 'unknown' | 'unconfirmed' | 'recorded-read';
		readAt: string | null;
	};
}

async function inboxFiles(name: string): Promise<string[]> {
	return readdir(join(fixture.records, 'mailboxes', name, 'inbox')).catch((error: unknown) => {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
		throw error;
	});
}

test('only the sender sees an unconfirmed then recorded read, without new receipt mail', async () => {
	const id = await send();
	expect(await status('alpha', id)).toEqual({ id, status: 'unconfirmed', readAt: null });
	expect(await status('beta', id)).toEqual({ id, status: 'unknown', readAt: null });
	expect((await fixture.run(['--mail', 'receive'], 'beta')).code).toBe(0);
	const read = await status('alpha', id);
	expect(read.status).toBe('recorded-read');
	expect(Number.isFinite(Date.parse(read.readAt ?? ''))).toBe(true);
	const senderRetention = await fixture.run(['--mail-retention', 'preview'], 'alpha');
	expect(senderRetention.code).toBe(0);
	const senderInventory = JSON.parse(senderRetention.out) as {
		coverage: { inventoryComplete: boolean };
		rows: { path: string }[];
	};
	expect(senderInventory.coverage.inventoryComplete).toBe(true);
	expect(senderInventory.rows.map((row) => row.path)).toContain(`sent-status/${id}.json`);
	expect(await inboxFiles('alpha')).toEqual([]);
	const confirmation = await fixture.run(['--mail', 'confirm', id, 'Understood.'], 'beta');
	expect(confirmation.code).toBe(0);
	const confirmationId = (JSON.parse(confirmation.out) as { id: string }).id;
	expect(await status('beta', confirmationId)).toEqual({
		id: confirmationId,
		status: 'unknown',
		readAt: null,
	});
	const reply = await fixture.run(['--mail', 'reply', id, 'Done.'], 'beta');
	expect(reply.code).toBe(0);
	const replyId = (JSON.parse(reply.out) as { id: string }).id;
	expect((await status('beta', replyId)).status).toBe('unconfirmed');
	expect(await readdir(join(fixture.records, 'mailboxes', 'beta', 'sent-status'))).toEqual([
		`${replyId}.json`,
	]);
});

test('header-only and unacknowledged checkpoint pages do not claim a read', async () => {
	const id = await send();
	const first = await fixture.run(['--checkpoint'], 'beta');
	expect(first.code).toBe(0);
	expect(await status('alpha', id)).toEqual({ id, status: 'unconfirmed', readAt: null });
	const page = JSON.parse(first.out) as { receipt: string };
	expect((await fixture.run(['--checkpoint', page.receipt], 'beta')).code).toBe(0);
	expect((await status('alpha', id)).status).toBe('recorded-read');
});

test('a failed projection keeps local read coverage and recovers on the next owned read', async () => {
	const id = await send();
	const sent = join(fixture.records, 'mailboxes', 'alpha', 'sent-status', `${id}.json`);
	const backup = `${sent}.test-backup`;
	await rename(sent, backup);
	await mkdir(sent);
	try {
		const read = await fixture.run(['--mail', 'receive'], 'beta');
		expect(read.code).toBe(0);
		expect(
			await Bun.file(
				join(fixture.records, 'mailboxes', 'beta', 'delivery', `${id}.read`),
			).exists(),
		).toBe(true);
		expect(
			await Bun.file(
				join(
					fixture.records,
					'mailboxes',
					'beta',
					'delivery',
					'pending-read',
					`${id}.json`,
				),
			).exists(),
		).toBe(true);
		const retention = await fixture.run(['--mail-retention', 'preview'], 'beta');
		expect(retention.code).toBe(0);
		const inventory = JSON.parse(retention.out) as {
			coverage: { inventoryComplete: boolean };
			rows: { path: string }[];
		};
		expect(inventory.coverage.inventoryComplete).toBe(true);
		expect(inventory.rows.map((row) => row.path)).toContain(`delivery/pending-read/${id}.json`);
	} finally {
		await rmdir(sent);
		await rename(backup, sent);
	}
	const recovery = await fixture.run(['--mail', 'receive'], 'beta');
	expect(recovery.code).toBe(0);
	expect((await status('alpha', id)).status).toBe('recorded-read');
	expect(
		await Bun.file(
			join(fixture.records, 'mailboxes', 'beta', 'delivery', 'pending-read', `${id}.json`),
		).exists(),
	).toBe(false);
});

test('a fixed three-message workload produces no read-receipt messages', async () => {
	const ids = await Promise.all([send(), send(), send()]);
	const result = await fixture.run(['--mail', 'receive'], 'beta');
	expect(result.code).toBe(0);
	for (const id of ids) expect((await status('alpha', id)).status).toBe('recorded-read');
	expect(await inboxFiles('alpha')).toEqual([]);
	expect(await readdir(join(fixture.records, 'mailboxes', 'alpha', 'sent-status'))).toHaveLength(
		3,
	);
});

test('an interrupted legacy receipt stays retryable and an already published retry is idempotent', async () => {
	const id = await send();
	await unlink(join(fixture.records, 'mailboxes', 'alpha', 'sent-status', `${id}.json`));
	expect((await fixture.run(['--comms', 'halt'])).code).toBe(0);
	const first = await fixture.run(['--mail', 'receive'], 'beta');
	expect(first.code).toBe(0);
	expect(
		await Bun.file(
			join(fixture.records, 'mailboxes', 'beta', 'delivery', `${id}.read`),
		).exists(),
	).toBe(true);
	expect(await inboxFiles('alpha')).toEqual([]);
	expect((await fixture.run(['--comms', 'proceed'])).code).toBe(0);
	expect((await fixture.run(['--mail', 'receive'], 'beta')).code).toBe(0);
	const receipts = await inboxFiles('alpha');
	expect(receipts).toHaveLength(1);
	const receiptId = receipts[0]?.slice(0, -3);
	if (!receiptId) throw new Error('Missing legacy receipt ID.');
	expect((await status('beta', receiptId)).status).toBe('unknown');
	const pending = join(
		fixture.records,
		'mailboxes',
		'beta',
		'delivery',
		'pending-read',
		`${id}.json`,
	);
	await writeFile(
		pending,
		JSON.stringify({ id, from: 'alpha', kind: 'request', readAt: new Date().toISOString() }),
	);
	expect((await fixture.run(['--mail', 'receive'], 'beta')).code).toBe(0);
	expect(await inboxFiles('alpha')).toEqual(receipts);
	expect((await fixture.run(['--mail', 'receive'], 'alpha')).code).toBe(0);
	expect((await fixture.run(['--mail', 'history'], 'alpha')).out).toContain('Read receipt for');
});

test('recovery refuses a pending fact whose sender differs from the retained mail', async () => {
	const id = await send();
	const dir = join(fixture.records, 'mailboxes', 'beta', 'delivery', 'pending-read');
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, `${id}.json`),
		JSON.stringify({ id, from: 'gamma', kind: 'request', readAt: new Date().toISOString() }),
	);
	const read = await fixture.run(['--mail', 'receive'], 'beta');
	expect(read.code).toBe(1);
	expect(read.error).toContain('Pending read-status sender mismatch');
	expect(await status('alpha', id)).toEqual({ id, status: 'unconfirmed', readAt: null });
	expect(
		await Bun.file(
			join(fixture.records, 'mailboxes', 'beta', 'delivery', `${id}.read`),
		).exists(),
	).toBe(false);
});
