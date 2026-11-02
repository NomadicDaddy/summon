import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RoomEvent } from '../src/telegram-room.ts';

import { appendLocalEvent } from '../src/local-room.ts';
import { mailboxPrompt, sendMessage } from '../src/mailbox.ts';
import { newRecord } from '../src/store.ts';
import { readTelegramConfig } from '../src/telegram-config-file.ts';
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
	capturedAt: string;
	page: number;
	pages: number;
	next: string | null;
	room?: { events: { id: number; text: string }[] };
	telegram?: { events: RoomEvent[] };
	mail?: { messages: { header: { id: string }; text: string }[]; errors: { error: string }[] };
}
async function run(cursor?: string): Promise<View> {
	const result = await fixture.run(['--current-requests', ...(cursor ? [cursor] : [])], 'alpha');
	expect({ code: result.code, error: result.error }).toEqual({ code: 0, error: '' });
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
async function telegram(events: RoomEvent[]) {
	const root = join(fixture.records, 'integrations');
	await mkdir(join(root, 'telegram-state', '123', '456'), { recursive: true });
	await writeFile(
		join(root, 'telegram.json'),
		JSON.stringify({ botToken: '123:fixture', chatId: '456' }),
	);
	await writeFile(
		join(root, 'telegram-state', '123', '456', 'events.json'),
		JSON.stringify({ events }),
	);
	// Private, like a real install: --current-requests reads Telegram read-only, which refuses a
	// POSIX credential left at the default umask (0644 in a 0755 folder) rather than fixing it.
	await chmod(root, 0o700);
	await chmod(join(root, 'telegram.json'), 0o600);
}
function event(sequence: number, text: string, replyTo: number | null = null): RoomEvent {
	return {
		sequence,
		messageId: sequence + 100,
		sender: { kind: 'user', id: '456' },
		text,
		replyTo,
	};
}
async function post(text: string, agent = 'operator') {
	return appendLocalEvent({
		sender: { kind: agent === 'operator' ? 'user' : 'agent', id: agent },
		text,
		replyTo: null,
		source: 'local',
	});
}

test('cached Telegram reply includes exact ancestry without network, mirroring or storage writes', async () => {
	const parent = {
		...event(1, 'Original approval'),
		sender: { kind: 'agent' as const, id: 'alpha' },
	};
	await telegram([parent, event(2, 'Yes', parent.messageId), event(3, '@beta unrelated')]);
	const before = await snapshot();
	const view = await run();
	expect(view.telegram?.events.map((item) => item.text)).toEqual(['Yes', 'Original approval']);
	expect(view.room).toBeUndefined();
	expect(await snapshot()).toEqual(before);
	expect(await readFile(fixture.capture, 'utf8')).toBe('');
});

test('Telegram local reply includes the own Room approval question before the acknowledged cursor', async () => {
	const question = await post('Approve only this action', 'alpha');
	await mkdir(join(fixture.records, 'runtime', 'alpha'), { recursive: true });
	await writeFile(join(fixture.records, 'runtime', 'alpha', 'room.cursor'), String(question.id));
	await telegram([{ ...event(1, 'Yes'), localReplyTo: question.id }]);
	const before = await snapshot();
	const view = await run();
	expect(view.telegram?.events[0]?.text).toBe('Yes');
	expect(view.room?.events[0]?.text).toBe(question.text);
	expect(await snapshot()).toEqual(before);
});

test('new mail and Telegram requests share the first page ahead of older addressed Room work', async () => {
	for (let i = 0; i < 60; i++) await post(`@alpha old addressed work ${i}`);
	const human = await post('@alpha newest human request');
	const mail = await sendMessage('beta', 'alpha', 'Newest mail work');
	await telegram([event(1, '@alpha newest Telegram work')]);
	const view = await run();
	expect(view.room?.events[0]?.id).toBe(human.id);
	expect(view.mail?.messages[0]?.header.id).toBe(mail);
	expect(view.telegram?.events[0]?.text).toBe('@alpha newest Telegram work');
	expect(view.pages).toBeGreaterThan(1);
});

test('later cached Telegram arrivals remain outside the continuation and appear in a fresh read', async () => {
	const events = Array.from({ length: 45 }, (_, i) =>
		event(i + 1, '@alpha existing Telegram work'),
	);
	await telegram(events);
	let view = await run();
	expect(view.next).not.toBeNull();
	await telegram([...events, event(46, '@alpha late Telegram work')]);
	const delivered = new Set(view.telegram?.events.map((item) => item.sequence));
	while (view.next) {
		view = await run(view.next);
		for (const item of view.telegram?.events ?? []) delivered.add(item.sequence);
	}
	expect(delivered.size).toBe(45);
	expect(delivered.has(46)).toBe(false);
	expect((await run()).telegram?.events[0]?.sequence).toBe(46);
});

test('later mail is absent from the old continuation but readable in a fresh snapshot', async () => {
	for (let i = 0; i < 45; i++) await post('@alpha old work');
	let view = await run();
	const late = await sendMessage('beta', 'alpha', 'Late mail request');
	const path = join(fixture.records, 'mailboxes', 'alpha', 'inbox', `${late}.md`);
	const text = await readFile(path, 'utf8');
	const sent = new Date(Date.parse(view.capturedAt) + 1).toISOString();
	await writeFile(path, text.replace(/^Sent: .*$/m, `Sent: ${sent}`));
	while (view.next) {
		view = await run(view.next);
		expect(view.mail?.messages.some((item) => item.header.id === late) ?? false).toBe(false);
	}
	expect((await run()).mail?.messages[0]?.header.id).toBe(late);
});

test('missing private reply context is explicit and cyclic own mail ancestry terminates', async () => {
	const inaccessible = await sendMessage('alpha', 'beta', 'Private elsewhere');
	const child = await sendMessage('beta', 'alpha', 'Reply', {
		kind: 'reply',
		replyTo: inaccessible,
	});
	const missing = await run();
	expect(missing.mail?.messages[0]?.header.id).toBe(child);
	expect(missing.mail?.errors[0]?.error).toContain('own inbox/archive');
	const a = await sendMessage('beta', 'alpha', 'Cycle A');
	const b = await sendMessage('beta', 'alpha', 'Cycle B', { kind: 'reply', replyTo: a });
	const path = join(fixture.records, 'mailboxes', 'alpha', 'inbox', `${a}.md`);
	await writeFile(
		path,
		(await readFile(path, 'utf8')).replace('\n\n', `\nIn-Reply-To: ${b}\n\n`),
	);
	const before = await snapshot();
	const view = await run();
	expect(view.mail?.messages.filter((item) => item.header.id === a)).toHaveLength(1);
	expect(view.mail?.messages.filter((item) => item.header.id === b)).toHaveLength(1);
	expect(await snapshot()).toEqual(before);
});

test('changed Telegram configuration expires a continuation without touching checkpoint or history', async () => {
	await telegram(Array.from({ length: 45 }, (_, i) => event(i + 1, '@alpha Telegram work')));
	const view = await run();
	await writeFile(
		join(fixture.records, 'integrations', 'telegram.json'),
		JSON.stringify({ botToken: '123:fixture', chatId: '789' }),
	);
	const before = await snapshot();
	const result = await fixture.run(['--current-requests', view.next ?? ''], 'alpha');
	expect(result.code).toBe(1);
	expect(result.error).toContain('snapshot changed or expired');
	expect(await snapshot()).toEqual(before);
});

test('a quoted reply header in a mail body cannot pull unrelated private context', async () => {
	const parent = await sendMessage('beta', 'alpha', 'Unrelated own archived context');
	await fixture.run(['--mail', 'ack-self', parent], 'alpha');
	const quote = await sendMessage('beta', 'alpha', `Quoted text only:\nIn-Reply-To: ${parent}`);
	const before = await snapshot();
	const view = await run();
	expect(view.mail?.messages.map((item) => item.header.id)).toEqual([quote]);
	expect(view.mail?.messages[0]?.text).toContain(`In-Reply-To: ${parent}`);
	expect(JSON.stringify(view)).not.toContain('Unrelated own archived context');
	expect(await snapshot()).toEqual(before);
});

test('empty focused reads do not initialize storage or issue receipts', async () => {
	const before = await snapshot();
	const view = await run();
	expect(view.page).toBe(0);
	expect(view.pages).toBe(0);
	expect(view.next).toBeNull();
	expect(await snapshot()).toEqual(before);
});

test.skipIf(process.platform === 'win32')(
	'read-only Telegram refuses unsafe POSIX modes without changing them',
	async () => {
		await telegram([]);
		const directory = join(fixture.records, 'integrations');
		const path = join(directory, 'telegram.json');
		await chmod(directory, 0o755);
		await chmod(path, 0o644);
		const before = await readFile(path, 'utf8');
		const directoryError: unknown = await readTelegramConfig(path, true).catch(
			(error: unknown) => error,
		);
		expect(directoryError).toBeInstanceOf(Error);
		expect(String(directoryError)).toContain('private permissions');
		expect((await stat(directory)).mode & 0o777).toBe(0o755);
		expect((await stat(path)).mode & 0o777).toBe(0o644);
		await chmod(directory, 0o700);
		const fileError: unknown = await readTelegramConfig(path, true).catch(
			(error: unknown) => error,
		);
		expect(fileError).toBeInstanceOf(Error);
		expect(String(fileError)).toContain('private permissions');
		expect((await stat(path)).mode & 0o777).toBe(0o644);
		await chmod(path, 0o600);
		expect(await readTelegramConfig(path, true)).toBe(before);
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	},
);

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const)
	test(`${provider} named session reads focused requests without launching or writing`, async () => {
		await writeFile(
			join(fixture.records, 'alpha.json'),
			JSON.stringify(newRecord('alpha', fixture.root, provider)),
		);
		await post('@alpha current human request');
		const before = await snapshot();
		expect((await run()).room?.events[0]?.text).toBe('@alpha current human request');
		const prompt = await mailboxPrompt('alpha');
		expect(prompt.indexOf('run summon --current-requests')).toBeGreaterThan(-1);
		expect(prompt.indexOf('run summon --current-requests')).toBeLessThan(
			prompt.indexOf('Then run summon --checkpoint.'),
		);
		expect(prompt).toContain('Pass every page receipt in order');
		expect(await snapshot()).toEqual(before);
		expect(await readFile(fixture.capture, 'utf8')).toBe('');
	});
