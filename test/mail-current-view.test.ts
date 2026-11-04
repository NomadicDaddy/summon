import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { receiveMail } from '../src/mail-read.ts';
import { sendMessage } from '../src/mailbox.ts';
import { newRecord } from '../src/store.ts';
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

interface Page {
	messages: { header: { id: string }; text?: string; oversized?: boolean }[];
	errors: unknown[];
	next: string | null;
	view?: string;
	instruction: string;
	pendingCount?: number;
	unreadCount?: number;
}
async function receive(args: string[] = []): Promise<Page> {
	const result = await fixture.run(['--mail', 'receive', ...args], 'alpha');
	expect(result.code).toBe(0);
	return JSON.parse(result.out) as Page;
}

test.each(['claude', 'codex', 'grok', 'kilo'] as const)(
	'%s receive explains read coverage without handling pending mail',
	async (provider) => {
		await writeFile(
			join(fixture.records, 'alpha.json'),
			JSON.stringify(newRecord('alpha', fixture.root, provider)),
		);
		const id = await sendMessage('beta', 'alpha', 'still needs handling');
		const preview = await receiveMail('alpha', '', false);
		expect(preview.instruction).toContain('This view does not mark messages read.');
		expect(preview.messages[0]?.header.id).toBe(id);
		const unread = await receive();
		expect(unread.messages[0]?.header.id).toBe(id);
		expect(unread.instruction).toContain('Complete returned bodies are marked read');
		expect((await receive()).unreadCount).toBe(0);
		const pending = await receive(['--pending']);
		expect(pending.view).toBe('pending');
		expect(pending.messages[0]?.header.id).toBe(id);
		expect(pending.instruction).toContain('other mail remains pending until handled');
		expect(pending.instruction).toContain('recoverable with --mail history');
	},
);

test('read requests remain pending while current mail exposes newer unread work', async () => {
	const old = await sendMessage('beta', 'alpha', 'previously read but unresolved');
	const frozen = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as {
		receipt: string;
	};
	expect((await receive()).messages[0]?.header.id).toBe(old);
	await Bun.sleep(2);
	const fresh = await sendMessage('beta', 'alpha', 'current work');
	const page = await receive();
	expect(page.view).toBe('unread');
	expect(page.instruction).toContain('Complete returned bodies are marked read');
	expect(page.instruction).toContain('Reading is not handling');
	expect(page.messages.map((item) => item.header.id)).toEqual([fresh]);
	expect(page.pendingCount).toBe(2);
	expect(page.unreadCount).toBe(1);
	expect((await receive()).messages).toEqual([]);
	const pending = await receive(['--pending']);
	expect(pending.view).toBe('pending');
	expect(pending.instruction).toContain('--mail ack-self <id>');
	expect(pending.messages.map((item) => item.header.id)).toEqual([old, fresh]);
	expect(
		await Bun.file(join(fixture.records, 'mailboxes', 'alpha', 'inbox', `${old}.md`)).exists(),
	).toBe(true);
	// A direct body read does not acknowledge a package frozen before that read.
	const checkpoint = await fixture.run(['--checkpoint'], 'alpha');
	expect(checkpoint.out).toContain(old);
	expect(checkpoint.out).not.toContain(fresh);
	expect((JSON.parse(checkpoint.out) as { receipt: string }).receipt).toBe(frozen.receipt);
	const final = JSON.parse(
		(await fixture.run(['--checkpoint', frozen.receipt], 'alpha')).out,
	) as { receipt: string };
	const settled = JSON.parse(
		(await fixture.run(['--checkpoint', final.receipt], 'alpha')).out,
	) as { changed: boolean; more: boolean };
	expect(settled).toMatchObject({ changed: false, more: false });
	expect((await receive(['--pending'])).messages).toHaveLength(2);
});

test('newest-first current pages remain traversable after prior pages are marked read', async () => {
	const ids: string[] = [];
	for (let index = 0; index < 12; index++) {
		ids.push(await sendMessage('beta', 'alpha', `item ${index}`));
		await Bun.sleep(2);
	}
	const first = await receive();
	expect(first.messages.map((item) => item.header.id)).toEqual(ids.slice(2).reverse());
	expect(first.unreadCount).toBe(12);
	expect(first.next).toBe(ids[2] ?? null);
	const later = await sendMessage('beta', 'alpha', 'arrived during read');
	const second = await receive([first.next ?? '']);
	expect(second.messages.map((item) => item.header.id)).toEqual(ids.slice(0, 2).reverse());
	expect(second.next).toBeNull();
	expect((await receive()).messages.map((item) => item.header.id)).toEqual([later]);
	expect((await receive()).pendingCount).toBe(13);
});

test('oversized current mail stays unread until complete chunks, archived history stays read-only', async () => {
	const body = '界'.repeat(10000);
	const id = await sendMessage('beta', 'alpha', body);
	const first = await receive();
	expect(first.messages[0]?.oversized).toBe(true);
	expect(first.instruction).toContain('header-only entries are not');
	expect((await receive()).messages[0]?.header.id).toBe(id);
	expect((await fixture.run(['--mail', 'confirm', id, 'premature'], 'alpha')).code).toBe(1);
	const head = await fixture.run(
		['--mail', 'read-self', id, '--offset', '0', '--limit', '4096'],
		'alpha',
	);
	const chunk = JSON.parse(head.out) as { end: number };
	const tail = await fixture.run(
		['--mail', 'read-self', id, '--offset', String(chunk.end), '--limit', '32768'],
		'alpha',
	);
	expect(tail.code).toBe(0);
	expect((await receive()).messages).toEqual([]);
	expect((await fixture.run(['--mail', 'confirm', id, 'read fully'], 'alpha')).code).toBe(0);
	expect((await fixture.run(['--mail', 'ack-self', id], 'alpha')).code).toBe(0);
	const coverage = await fixture.read(`mailboxes/alpha/delivery/${id}.offset`);
	const history = await fixture.run(['--mail', 'history'], 'alpha');
	expect(history.code).toBe(0);
	expect((JSON.parse(history.out) as Page).instruction).toBe(
		'Read-only archive; no read coverage or handling state changed.',
	);
	expect((JSON.parse(history.out) as Page).messages[0]?.header.id).toBe(id);
	const archived = await fixture.run(
		['--mail', 'read-history', id, '--offset', '0', '--limit', '32768'],
		'alpha',
	);
	expect(archived.code).toBe(0);
	expect(archived.out).toContain(body);
	expect(await fixture.read(`mailboxes/alpha/delivery/${id}.offset`)).toBe(coverage);
	expect(
		await Bun.file(join(fixture.records, 'mailboxes', 'alpha', 'inbox', `${id}.md`)).exists(),
	).toBe(false);
	expect(
		(await fixture.run(['--mail', 'confirm', id, 'cannot confirm history'], 'alpha')).code,
	).toBe(1);
	// No name argument can route this current/history API into a teammate's mailbox.
	expect((await fixture.run(['--mail', 'history', 'beta'], 'alpha')).code).toBe(1);
	expect(
		(
			await fixture.run(
				['--mail', 'read-history', id, '--offset', '0', '--limit', '32768'],
				'beta',
			)
		).code,
	).toBe(1);
});
