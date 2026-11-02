import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { appendLocalEvent } from '../src/local-room.ts';
import { statePath } from '../src/mail-read.ts';
import { sendMessage } from '../src/mailbox.ts';
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

interface View {
	readOnly: boolean;
	page: number;
	pages: number;
	next: string | null;
	receipt?: string;
	room?: {
		events: { id: number; text: string; question?: { kind: string } }[];
		nextCursor?: number;
	};
	mail?: { messages: { header: { id: string }; text?: string }[]; errors: { error: string }[] };
	fragments?: {
		source: string;
		id: string;
		text: string;
		offset: number;
		end: number;
		size: number;
	}[];
}
async function run(cursor?: string, agent = 'alpha'): Promise<View> {
	const result = await fixture.run(['--current-requests', ...(cursor ? [cursor] : [])], agent);
	expect({ code: result.code, error: result.error }).toEqual({ code: 0, error: '' });
	expect(Buffer.byteLength(result.out)).toBeLessThan(34000);
	return JSON.parse(result.out) as View;
}
async function snapshot(path = fixture.records): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const file = join(path, entry.name);
		if (entry.isDirectory()) Object.assign(result, await snapshot(file));
		else
			result[file] = createHash('sha256')
				.update(await readFile(file))
				.digest('hex');
	}
	return result;
}
async function post(
	text: string,
	kind: 'agent' | 'user' = 'user',
	replyTo: number | null = null,
	name = 'operator',
) {
	return appendLocalEvent({ sender: { kind, id: name }, text, replyTo, source: 'local' });
}

test('new addressed body precedes routine backlog and leaves the entire store byte-identical', async () => {
	for (let i = 0; i < 120; i++) await post('Routine peer traffic', 'agent', null, 'beta');
	await post('@beta work for somebody else');
	await post('@alpha current task');
	await mkdir(join(fixture.records, 'runtime', 'alpha'), { recursive: true });
	await writeFile(
		join(fixture.records, 'runtime', 'alpha', 'checkpoint.json'),
		'pending receipt sentinel',
	);
	const before = await snapshot();
	const view = await run();
	expect(view.room?.events.map((event) => event.text)).toEqual(['@alpha current task']);
	expect(view.readOnly).toBe(true);
	expect(view.receipt).toBeUndefined();
	expect(view.room?.nextCursor).toBeUndefined();
	expect(await snapshot()).toEqual(before);
});

test('a human answer includes its exact old approval question and own reply ancestry', async () => {
	const question = await appendLocalEvent({
		sender: { kind: 'agent', id: 'alpha' },
		text: 'Approve the bounded action',
		replyTo: null,
		source: 'local',
		question: { kind: 'approval', choices: ['Yes', 'No'], allowFreeform: false },
	});
	await mkdir(join(fixture.records, 'runtime', 'alpha'), { recursive: true });
	await writeFile(join(fixture.records, 'runtime', 'alpha', 'room.cursor'), String(question.id));
	await appendLocalEvent({
		sender: { kind: 'user', id: 'operator' },
		text: 'Yes',
		replyTo: question.id,
		source: 'local',
		answer: { questionId: question.id, choice: 0 },
	});
	const before = await snapshot();
	const view = await run();
	expect(view.room?.events.map((event) => event.text)).toEqual(['Yes', question.text]);
	expect(view.room?.events[1]?.question?.kind).toBe('approval');
	expect(await snapshot()).toEqual(before);
});

test('fresh requests remain visible during an older frozen checkpoint without advancing it', async () => {
	for (let i = 0; i < 45; i++) await post('Older human history');
	const frozen = await fixture.run(['--checkpoint'], 'alpha');
	expect(frozen.code).toBe(0);
	const packet = await fixture.read('runtime/alpha/checkpoint-package.json');
	const state = await fixture.read('runtime/alpha/checkpoint.json');
	const late = await post('@alpha arrival after the frozen boundary');
	const view = await run();
	expect(view.room?.events[0]?.id).toBe(late.id);
	expect(await fixture.read('runtime/alpha/checkpoint-package.json')).toBe(packet);
	expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(state);
});

test('UTF-8 fragmented mail reconstructs exactly without a read marker or receipt', async () => {
	const id = await sendMessage('beta', 'alpha', '界😀\\"\u0001'.repeat(9000));
	const before = await snapshot();
	let view = await run();
	let text = '';
	let offset = 0;
	let pages = 0;
	for (;;) {
		for (const part of view.fragments ?? []) {
			expect(part.source).toBe('mail');
			expect(part.id).toBe(id);
			expect(part.offset).toBe(offset);
			text += part.text;
			offset = part.end;
		}
		pages++;
		if (!view.next) break;
		view = await run(view.next);
	}
	const restored = JSON.parse(text) as { header: { id: string }; text: string };
	expect(restored.header.id).toBe(id);
	expect(restored.text).toBe(await fixture.read(`mailboxes/alpha/inbox/${id}.md`));
	expect(pages).toBeGreaterThan(2);
	expect(await Bun.file(statePath('alpha', id, 'read')).exists()).toBe(false);
	expect(await snapshot()).toEqual(before);
});

test('pagination excludes later room arrivals, while a fresh focused read includes them', async () => {
	for (let i = 0; i < 45; i++) await post(`@alpha existing request ${i}`);
	let view = await run();
	expect(view.next).not.toBeNull();
	const late = await post('@alpha new request during focused pagination');
	const delivered = new Set(view.room?.events.map((event) => event.id));
	while (view.next) {
		view = await run(view.next);
		for (const event of view.room?.events ?? []) delivered.add(event.id);
	}
	expect(delivered.has(late.id)).toBe(false);
	expect(delivered.size).toBe(45);
	expect((await run()).room?.events[0]?.id).toBe(late.id);
});

test('mail confirmations and receipts do not displace work and no peer inbox is exposed', async () => {
	const privateId = await sendMessage('alpha', 'beta', 'PRIVATE PEER-INBOX POSITIVE CONTROL');
	const id = await sendMessage('beta', 'alpha', 'Work reply', {
		kind: 'reply',
		replyTo: privateId,
	});
	await sendMessage('beta', 'alpha', 'Bookkeeping confirmation', { kind: 'confirmation' });
	await sendMessage('beta', 'alpha', 'Bookkeeping receipt', { kind: 'receipt' });
	const before = await snapshot();
	const view = await run();
	expect(view.mail?.messages.map((message) => message.header.id)).toEqual([id]);
	expect(JSON.stringify(view)).not.toContain('PRIVATE PEER-INBOX POSITIVE CONTROL');
	expect(await snapshot()).toEqual(before);
});

test('own archived reply context is readable without archival changes', async () => {
	const parent = await sendMessage('beta', 'alpha', 'Original bounded request');
	await fixture.run(['--mail', 'ack-self', parent], 'alpha');
	const reply = await sendMessage('beta', 'alpha', 'Follow-up', {
		kind: 'reply',
		replyTo: parent,
	});
	const before = await snapshot();
	const view = await run();
	expect(view.mail?.messages.map((message) => message.header.id)).toEqual([reply, parent]);
	expect(await snapshot()).toEqual(before);
});

test('invalid, foreign-owner and changed-body continuations fail without any writes', async () => {
	for (let i = 0; i < 45; i++) await post('Global human history');
	const foreign = await run(undefined, 'beta');
	const own = await run();
	const before = await snapshot();
	for (const token of ['../beta', foreign.next ?? '', 'x'.repeat(2049)]) {
		const result = await fixture.run(['--current-requests', token], 'alpha');
		expect(result.code).toBe(1);
	}
	const history = JSON.parse(await fixture.read('room/events.json')) as { text: string }[];
	const event = history.at(-1);
	if (!event) throw new Error('Missing positive control');
	event.text = 'Changed body';
	await writeFile(join(fixture.records, 'room', 'events.json'), JSON.stringify(history));
	const changed = await fixture.run(['--current-requests', own.next ?? ''], 'alpha');
	expect(changed.code).toBe(1);
	expect(changed.error).toContain('snapshot changed or expired');
	const after = await snapshot();
	Reflect.deleteProperty(before, join(fixture.records, 'room', 'events.json'));
	Reflect.deleteProperty(after, join(fixture.records, 'room', 'events.json'));
	expect(after).toEqual(before);
});

test('text output is complete and clearly distinguishes this view from checkpoint receipts', async () => {
	await post('@alpha exact Unicode 界😀 and \u001b controls');
	const before = await snapshot();
	const result = await fixture.run(['--current-requests', '--format', 'text'], 'alpha');
	expect(result.code).toBe(0);
	expect(result.out).toStartWith('CURRENT REQUESTS (READ ONLY)');
	expect(result.out).toContain('exact Unicode 界😀 and \\u001b controls');
	expect(result.out).toContain('no receipt or read coverage was issued');
	expect(await snapshot()).toEqual(before);
	for (const args of [
		['--format', 'json'],
		['extra', 'argument'],
	])
		expect((await fixture.run(['--current-requests', ...args], 'alpha')).code).toBe(1);
	expect((await fixture.run(['--current-requests'])).code).toBe(1);
});
