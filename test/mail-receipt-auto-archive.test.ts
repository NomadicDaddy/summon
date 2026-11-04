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

const mailPath = (folder: 'inbox' | 'archive', id: string) =>
	join(fixture.records, 'mailboxes', 'alpha', folder, `${id}.md`);

interface Page {
	messages: { header: { id: string; kind: string }; text?: string; oversized?: boolean }[];
	instruction: string;
	next: string | null;
	pendingCount?: number;
	unreadCount?: number;
	view?: string;
	result?: string;
}

async function receive(args: string[] = []): Promise<Page> {
	const result = await fixture.run(['--mail', 'receive', ...args], 'alpha');
	expect(result.code).toBe(0);
	return JSON.parse(result.out) as Page;
}

async function setKind(id: string, kind: string): Promise<void> {
	const path = mailPath('inbox', id);
	await writeFile(path, (await readFile(path, 'utf8')).replace('Kind: request', `Kind: ${kind}`));
}

test('a complete receive archives only receipt-kind bookkeeping and retains exact history', async () => {
	const receipt = await sendMessage('beta', 'alpha', 'Bookkeeping', { kind: 'receipt' });
	const body = await readFile(mailPath('inbox', receipt), 'utf8');
	const request = await sendMessage('beta', 'alpha', 'Read receipt for an old request');
	const reply = await sendMessage('beta', 'alpha', 'Substantive reply', { kind: 'reply' });
	const confirmation = await sendMessage('beta', 'alpha', 'Confirmed', {
		kind: 'confirmation',
	});
	const notice = await sendMessage('beta', 'alpha', 'Notice body');
	const unknown = await sendMessage('beta', 'alpha', 'Future kind');
	await setKind(notice, 'notice');
	await setKind(unknown, 'future-kind');
	const first = await receive();
	expect(first.messages).toHaveLength(6);
	expect(first.unreadCount).toBe(6);
	expect(first.instruction).toContain('--mail history');
	expect(await Bun.file(mailPath('inbox', receipt)).exists()).toBe(false);
	expect(await readFile(mailPath('archive', receipt), 'utf8')).toBe(body);
	for (const id of [request, reply, confirmation, notice, unknown])
		expect(await Bun.file(mailPath('inbox', id)).exists()).toBe(true);
	const pending = await receive(['--pending']);
	expect(pending.messages.map((mail) => mail.header.id)).toHaveLength(5);
	expect(pending.messages.some((mail) => mail.header.id === request)).toBe(true);
	const history = await fixture.run(['--mail', 'history'], 'alpha');
	expect(history.code).toBe(0);
	expect((JSON.parse(history.out) as Page).messages[0]?.header.id).toBe(receipt);
	expect(await readFile(mailPath('archive', receipt), 'utf8')).toBe(body);
});

test('header-only and partial read-self leave an oversized receipt pending until its last byte', async () => {
	const id = await sendMessage('beta', 'alpha', '界'.repeat(9_000), { kind: 'receipt' });
	const body = await readFile(mailPath('inbox', id), 'utf8');
	const first = await receive();
	expect(first.messages[0]).toMatchObject({ oversized: true });
	expect(await Bun.file(mailPath('inbox', id)).exists()).toBe(true);
	const failed = await fixture.run(
		['--mail', 'read-self', id, '--offset', '999999', '--limit', '4096'],
		'alpha',
	);
	expect(failed.code).toBe(1);
	expect(await Bun.file(mailPath('inbox', id)).exists()).toBe(true);
	const head = await fixture.run(
		['--mail', 'read-self', id, '--offset', '0', '--limit', '4096'],
		'alpha',
	);
	expect(head.code).toBe(0);
	const end = (JSON.parse(head.out) as { end: number }).end;
	expect(await Bun.file(mailPath('inbox', id)).exists()).toBe(true);
	const tail = await fixture.run(
		['--mail', 'read-self', id, '--offset', String(end), '--limit', '32768'],
		'alpha',
	);
	expect(tail.code).toBe(0);
	expect(await Bun.file(mailPath('inbox', id)).exists()).toBe(false);
	expect(await readFile(mailPath('archive', id), 'utf8')).toBe(body);
	expect((await receive()).messages).toEqual([]);
	const history = await fixture.run(
		['--mail', 'read-history', id, '--offset', '0', '--limit', '32768'],
		'alpha',
	);
	expect(history.code).toBe(0);
	expect((JSON.parse(history.out) as { text: string }).text).toBe(body);
});

test('unread and pending continuation cursors survive their receipt boundary being archived', async () => {
	const ids: string[] = [];
	for (let index = 0; index < 12; index++) {
		ids.push(await sendMessage('beta', 'alpha', `Receipt ${index}`, { kind: 'receipt' }));
		await Bun.sleep(2);
	}
	const first = await receive();
	expect(first.messages).toHaveLength(10);
	expect(first.next).not.toBeNull();
	expect(await Bun.file(mailPath('archive', first.next ?? '')).exists()).toBe(true);
	const second = await receive([first.next ?? '']);
	expect(second.messages.map((mail) => mail.header.id)).toEqual(ids.slice(0, 2).reverse());
	expect(second.next).toBeNull();
	for (let index = 0; index < 12; index++)
		await sendMessage('beta', 'alpha', `Another ${index}`, { kind: 'receipt' });
	const pending = await receive(['--pending']);
	expect(pending.messages).toHaveLength(10);
	expect(pending.next).not.toBeNull();
	const last = await receive([pending.next ?? '', '--pending']);
	expect(last.messages).toHaveLength(2);
	expect(last.next).toBeNull();
	expect((await receive()).pendingCount).toBe(0);
});

test('checkpoint replay and concurrent receive archive one exact receipt after page coverage', async () => {
	const id = await sendMessage('beta', 'alpha', 'Frozen receipt', { kind: 'receipt' });
	const body = await readFile(mailPath('inbox', id), 'utf8');
	const first = await fixture.run(['--checkpoint'], 'alpha');
	expect(first.code).toBe(0);
	const receipt = (JSON.parse(first.out) as { receipt: string }).receipt;
	expect(await Bun.file(mailPath('inbox', id)).exists()).toBe(true);
	const replay = await fixture.run(['--checkpoint'], 'alpha');
	expect((JSON.parse(replay.out) as { receipt: string }).receipt).toBe(receipt);
	const [direct, acknowledged] = await Promise.all([
		fixture.run(['--mail', 'receive'], 'alpha'),
		fixture.run(['--checkpoint', receipt], 'alpha'),
	]);
	expect(direct.code).toBe(0);
	expect(acknowledged.code).toBe(0);
	expect(await readFile(mailPath('archive', id), 'utf8')).toBe(body);
	expect(await Bun.file(mailPath('inbox', id)).exists()).toBe(false);
	const finalReceipt = (JSON.parse(acknowledged.out) as { receipt: string }).receipt;
	expect((await fixture.run(['--checkpoint', finalReceipt], 'alpha')).code).toBe(0);
	expect(await readFile(mailPath('archive', id), 'utf8')).toBe(body);
});

test('held work stays pending even when its body or later kind resembles a receipt', async () => {
	const id = await sendMessage('beta', 'alpha', 'Read receipt for another message');
	await receive();
	expect((await fixture.run(['--mail', 'confirm', id, 'Needs approval'], 'alpha')).code).toBe(0);
	expect(
		(
			await fixture.run(
				['--mail', 'hold', id, 'Needs approval', 'Review this request'],
				'alpha',
			)
		).code,
	).toBe(0);
	expect(await Bun.file(mailPath('inbox', id)).exists()).toBe(true);
	expect(await Bun.file(mailPath('archive', id)).exists()).toBe(false);
	expect((await fixture.run(['--mail', 'ack-self', id], 'alpha')).code).toBe(1);
	await setKind(id, 'receipt');
	expect((await receive(['--pending'])).messages[0]?.header.kind).toBe('receipt');
	expect(await Bun.file(mailPath('inbox', id)).exists()).toBe(true);
	expect(await Bun.file(mailPath('archive', id)).exists()).toBe(false);
});

test('auto-archive reports a conflicting retained body without replacing either copy', async () => {
	const id = await sendMessage('beta', 'alpha', 'Original receipt', { kind: 'receipt' });
	const inbox = await readFile(mailPath('inbox', id), 'utf8');
	await mkdir(join(fixture.records, 'mailboxes', 'alpha', 'archive'));
	await writeFile(mailPath('archive', id), inbox.replace('Original receipt', 'Different body'));
	const result = await fixture.run(['--mail', 'receive'], 'alpha');
	expect(result.code).toBe(1);
	expect(result.error).toContain('Mail archive identity conflict');
	expect(await readFile(mailPath('inbox', id), 'utf8')).toBe(inbox);
	expect(await readFile(mailPath('archive', id), 'utf8')).toContain('Different body');
});
