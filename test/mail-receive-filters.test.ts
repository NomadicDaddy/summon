import { afterEach, beforeEach, expect, test } from 'bun:test';

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

interface Page {
	messages: { header: { id: string; kind: string }; text?: string }[];
	next: string | null;
	view?: string;
	filter?: { kind?: string; since?: string };
	instruction: string;
	pendingCount?: number;
	unreadCount?: number;
}
async function receive(args: string[] = []): Promise<Page> {
	const result = await fixture.run(['--mail', 'receive', ...args], 'alpha');
	expect(result.error).toBe('');
	expect(result.code).toBe(0);
	return JSON.parse(result.out) as Page;
}
const ids = (page: Page) => page.messages.map((item) => item.header.id);

async function spaced(count: number, text: string): Promise<string[]> {
	const sent: string[] = [];
	for (let index = 0; index < count; index++) {
		sent.push(await sendMessage('beta', 'alpha', `${text} ${index}`));
		await Bun.sleep(2);
	}
	return sent;
}

test('a kind filter lists only that kind and leaves the omitted mail unread', async () => {
	const ask = await sendMessage('beta', 'alpha', 'Please check.');
	await Bun.sleep(2);
	const answer = await sendMessage('beta', 'alpha', 'Checked.', { kind: 'reply', replyTo: ask });
	const page = await receive(['--kind', 'reply']);
	expect(ids(page)).toEqual([answer]);
	expect(page.filter).toEqual({ kind: 'reply' });
	expect(page.instruction).toContain('Filtered view (kind reply)');
	expect(page.instruction).toContain('not complete unread, pending or checkpoint coverage');
	// The counts still describe the whole unread view, read before this page is marked.
	expect(page.pendingCount).toBe(2);
	expect(page.unreadCount).toBe(2);
	expect((await receive(['--kind', 'reply'])).messages).toEqual([]);
	const rest = await receive();
	expect(ids(rest)).toEqual([ask]);
	expect(rest.filter).toBeUndefined();
	expect(rest.instruction).not.toContain('Filtered view');
	expect(ids(await receive(['--pending', '--kind', 'request']))).toEqual([ask]);
});

test('since keeps mail sent after a received message, from the inbox or the archive', async () => {
	const sent = await spaced(3, 'item');
	const [first, second, third] = sent;
	if (!first || !second || !third) throw new Error('Three messages were sent.');
	const unread = await receive(['--since', first]);
	expect(ids(unread)).toEqual([third, second]);
	expect(unread.instruction).toContain(`sent after ${first}`);
	expect(ids(await receive())).toEqual([first]);
	// The pending view keeps its own oldest-first order under the same filter.
	expect(ids(await receive(['--since', first, '--pending']))).toEqual([second, third]);
	expect((await fixture.run(['--mail', 'ack-self', first], 'alpha')).code).toBe(0);
	expect(ids(await receive(['--pending', '--since', first]))).toEqual([second, third]);
	expect(ids(await receive(['--pending', '--since', third]))).toEqual([]);
});

test('since refuses an unknown id and a message the caller did not receive', async () => {
	await sendMessage('beta', 'alpha', 'For alpha.');
	const foreign = await sendMessage('alpha', 'beta', 'For beta only.');
	for (const id of ['00000000-0000-4000-8000-000000000000', foreign]) {
		const result = await fixture.run(['--mail', 'receive', '--since', id], 'alpha');
		expect(result.code).toBe(1);
		expect(result.error).toContain('not in your own inbox or archive');
	}
	// Beta's mail was neither read nor marked by the refused lookups.
	expect(
		await fixture.read(`mailboxes/beta/delivery/${foreign}.read`).catch(() => null),
	).toBeNull();
	expect((await receive()).messages).toHaveLength(1);
});

test('combined filters continue across pages with the same filters and cursor', async () => {
	const asks = await spaced(12, 'ask');
	const answer = await sendMessage('beta', 'alpha', 'Answer.', {
		kind: 'reply',
		replyTo: asks[0] ?? '',
	});
	await Bun.sleep(2);
	const late = await sendMessage('beta', 'alpha', 'Late ask.');
	const anchor = asks[0] ?? '';
	const first = await receive(['--kind', 'request', '--since', anchor]);
	expect(ids(first)).toEqual([late, ...asks.slice(3).reverse()]);
	expect(first.next).toBe(asks[3] ?? null);
	const second = await receive([first.next ?? '', '--since', anchor, '--kind', 'request']);
	expect(ids(second)).toEqual(asks.slice(1, 3).reverse());
	expect(second.next).toBeNull();
	// Everything the filters omitted is still unread: the anchor itself and the reply.
	expect(ids(await receive())).toEqual([answer, anchor]);
});

test('malformed filters are usage errors that change nothing', async () => {
	const id = await sendMessage('beta', 'alpha', 'Untouched.');
	for (const args of [
		['--kind', 'bogus'],
		['--kind'],
		['--kind', '--pending'],
		['--kind', 'request', '--kind', 'reply'],
		['--since', 'not-a-uuid'],
		['--pending', '--pending'],
		[id, id],
		['--everything'],
	]) {
		const result = await fixture.run(['--mail', 'receive', ...args], 'alpha');
		expect(result.code).toBe(1);
		expect(result.out).toBe('');
	}
	expect((await fixture.run(['--mail', 'receive', '--kind', 'bogus'], 'alpha')).error).toContain(
		'request, reply, confirmation, receipt, rest-ready, notice',
	);
	expect(ids(await receive())).toEqual([id]);
});

test('a filtered read leaves pending and checkpoint coverage of omitted mail intact', async () => {
	const ask = await sendMessage('beta', 'alpha', 'Omitted ask.');
	await Bun.sleep(2);
	const answer = await sendMessage('beta', 'alpha', 'Read answer.', {
		kind: 'reply',
		replyTo: ask,
	});
	expect(ids(await receive(['--kind', 'reply']))).toEqual([answer]);
	expect(await fixture.read(`mailboxes/alpha/delivery/${ask}.read`).catch(() => null)).toBeNull();
	const checkpoint = await fixture.run(['--checkpoint'], 'alpha');
	expect(checkpoint.code).toBe(0);
	expect(checkpoint.out).toContain(ask);
	expect((await fixture.run(['--mail', 'confirm', ask, 'too early'], 'alpha')).code).toBe(1);
	expect(ids(await receive(['--pending']))).toEqual([ask, answer]);
});
