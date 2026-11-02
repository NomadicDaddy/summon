import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { sendHuman } from '../src/local-room-access.ts';
import { sendMessage } from '../src/mailbox.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const originalRoot = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (originalRoot === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = originalRoot;
	await fixture.dispose();
});

interface Batch {
	receipt: string;
	changed: boolean;
	more: boolean;
	mail?: {
		messages: { header: { id: string }; oversized?: boolean }[];
		errors: { id: string }[];
	};
}

async function checkpoint(receipt?: string): Promise<Batch> {
	const result = await fixture.run(
		receipt ? ['--checkpoint', receipt] : ['--checkpoint'],
		'alpha',
	);
	expect(result.code).toBe(0);
	return JSON.parse(result.out) as Batch;
}

async function seenMail(count = 25): Promise<Batch> {
	for (let index = 0; index < count; index++)
		await sendMessage('beta', 'alpha', `Existing ${index}`, { kind: 'receipt' });
	let batch = await checkpoint();
	for (let page = 0; (batch.changed || batch.more) && page < 10; page++)
		batch = await checkpoint(batch.receipt);
	expect(batch.changed).toBe(false);
	expect(batch.more).toBe(false);
	return batch;
}

test('seen mail settles in one call, while new mail behind it remains unread until acknowledged', async () => {
	const settled = await seenMail();
	const empty = await checkpoint(settled.receipt);
	expect(empty.changed).toBe(false);
	expect(empty.more).toBe(false);
	const id = await sendMessage('beta', 'alpha', 'New request behind seen pages');
	const read = join(fixture.records, 'mailboxes', 'alpha', 'delivery', `${id}.read`);
	const fresh = await checkpoint(empty.receipt);
	expect(fresh.mail?.messages.map((message) => message.header.id)).toEqual([id]);
	expect(await Bun.file(read).exists()).toBe(false);
	const replay = await checkpoint();
	expect(replay.receipt).toBe(fresh.receipt);
	expect(replay.mail).toEqual(fresh.mail);
	expect(await Bun.file(read).exists()).toBe(false);
	const last = await checkpoint(fresh.receipt);
	expect(last.changed).toBe(false);
	expect(last.more).toBe(true);
	expect((await checkpoint(last.receipt)).more).toBe(false);
	expect(await Bun.file(read).exists()).toBe(true);
	expect(
		await Bun.file(join(fixture.records, 'mailboxes', 'alpha', 'inbox', `${id}.md`)).exists(),
	).toBe(true);
});

test('room payload pressure defers unseen mail reached after seen pages', async () => {
	const settled = await seenMail(20);
	await sendHuman('界'.repeat(4096));
	await sendHuman('界'.repeat(4096));
	const id = await sendMessage('beta', 'alpha', 'x'.repeat(16000));
	const read = join(fixture.records, 'mailboxes', 'alpha', 'delivery', `${id}.read`);
	const crowded = await checkpoint(settled.receipt);
	expect(crowded.mail).toBeUndefined();
	expect(crowded.more).toBe(true);
	let delivered = await checkpoint(crowded.receipt);
	for (let page = 0; !delivered.mail && delivered.changed && page < 10; page++) {
		expect(await Bun.file(read).exists()).toBe(false);
		delivered = await checkpoint(delivered.receipt);
	}
	expect(delivered.mail?.messages[0]?.header.id).toBe(id);
	expect(await Bun.file(read).exists()).toBe(false);
	await checkpoint(delivered.receipt);
	expect(await Bun.file(read).exists()).toBe(true);
});

test('oversized mail requires every fragment page before read coverage', async () => {
	const settled = await seenMail(10);
	const id = await sendMessage('beta', 'alpha', '界'.repeat(20000));
	const fresh = await checkpoint(settled.receipt);
	expect(fresh.mail?.messages).toHaveLength(1);
	expect(fresh.mail?.messages[0]?.header.id).toBe(id);
	expect(fresh.mail?.messages[0]?.oversized).toBe(true);
	let next = await checkpoint(fresh.receipt);
	expect(
		await Bun.file(
			join(fixture.records, 'mailboxes', 'alpha', 'delivery', `${id}.read`),
		).exists(),
	).toBe(false);
	for (let page = 0; next.changed && page < 20; page++) next = await checkpoint(next.receipt);
	expect(next.changed).toBe(false);
	expect(next.more).toBe(true);
	expect(
		await Bun.file(
			join(fixture.records, 'mailboxes', 'alpha', 'delivery', `${id}.read`),
		).exists(),
	).toBe(true);
	expect((await checkpoint(next.receipt)).more).toBe(false);
});
