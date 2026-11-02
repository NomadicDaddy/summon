import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RoomEvent } from '../src/telegram-room.ts';

import { applyCatchUp } from '../src/checkpoint-skip-apply.ts';
import { prepareCatchUp } from '../src/checkpoint-skip-capture.ts';
import { skipProgress } from '../src/checkpoint-skip-progress.ts';
import { loadSkipPlan, skipBody } from '../src/checkpoint-skip-store.ts';
import { holdMessage } from '../src/mail-attention.ts';
import { confirmMessage, readOwnChunk } from '../src/mail-read.ts';
import { sendMessage } from '../src/mailbox.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
};
let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'test-launch';
	network = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(() => Promise.resolve(Response.json({ ok: true, result: [] })), {
			preconnect: () => undefined,
		}),
	);
});
afterEach(async () => {
	network.mockRestore();
	if (previous.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous.home;
	if (previous.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previous.agent;
	if (previous.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previous.nonce;
	await fixture.dispose();
});

async function telegram() {
	const root = join(fixture.records, 'integrations');
	const events: RoomEvent[] = [
		{
			sequence: 1,
			messageId: 101,
			sender: { kind: 'agent', id: 'alpha' },
			text: 'Approve exact A',
			replyTo: null,
		},
		{
			sequence: 2,
			messageId: 102,
			sender: { kind: 'user', id: '1' },
			text: 'Yes',
			replyTo: 101,
		},
	];
	for (let sequence = 3; sequence <= 45; sequence++)
		events.push({
			sequence,
			messageId: sequence + 100,
			sender: { kind: 'user', id: '1' },
			text: `@beta routine ${sequence} ${'x'.repeat(1100)}`,
			replyTo: null,
		});
	await mkdir(join(root, 'telegram-state/123/-456'), { recursive: true });
	await chmod(root, 0o700);
	await writeFile(
		join(root, 'telegram.json'),
		JSON.stringify({ botToken: '123:fixture', chatId: '-456', allowedUserIds: ['1'] }),
		{ mode: 0o600 },
	);
	await writeFile(join(root, 'telegram-state/123/-456/events.json'), JSON.stringify({ events }));
	return root;
}

async function incoming(text: string) {
	process.env.SUMMON_AGENT = 'beta';
	try {
		return await sendMessage('beta', 'alpha', text);
	} finally {
		process.env.SUMMON_AGENT = 'alpha';
	}
}

async function failure(operation: () => Promise<unknown>): Promise<string> {
	try {
		await operation();
	} catch (error: unknown) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error('Expected the operation to refuse.');
}

test('Telegram originals retain their correct sequence-based parent lookup and pending holds stay byte-identical', async () => {
	const message = await incoming('Held work, not skipped');
	await readOwnChunk('alpha', message, 0, 4096);
	await confirmMessage('alpha', message, 'Needs human authority');
	const { hold } = await holdMessage('alpha', message, 'Authority', 'Change A only');
	const heldPath = `mailboxes/alpha/holds/${hold.id}.json`;
	const heldBefore = await fixture.read(heldPath);
	await telegram();
	const { catchUp } = await prepareCatchUp('alpha', 1);
	expect(catchUp.skipped.telegram?.count).toBeGreaterThan(0);
	const plan = await loadSkipPlan('alpha', catchUp.id);
	const reply = skipBody(plan, 'telegram', '2');
	expect(reply.parents[0]).toMatchObject({ source: 'telegram', id: '1' });
	expect(reply.text).toContain('Yes');
	expect(skipBody(plan, 'telegram', '1').text).toContain('Approve exact A');
	await applyCatchUp('alpha', plan.id);
	expect(await fixture.read(heldPath)).toBe(heldBefore);
	expect((JSON.parse(await fixture.read(heldPath)) as { decision: string }).decision).toBe(
		'pending',
	);
	expect(
		await Bun.file(join(fixture.records, `mailboxes/alpha/inbox/${message}.md`)).exists(),
	).toBe(true);
	expect(await fixture.read('runtime/alpha/telegram-123--456.cursor')).toBe(
		String(plan.telegram?.through),
	);
	expect(network).toHaveBeenCalled();
});

test('an interrupted two-source apply resumes after Telegram advanced without acknowledging any old mail', async () => {
	await telegram();
	const message = await incoming('Unread direct work');
	const { catchUp } = await prepareCatchUp('alpha', 1);
	const plan = await loadSkipPlan('alpha', catchUp.id);
	const lock = join(fixture.records, 'runtime/alpha/room.cursor.lock');
	await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: 'live-fixture-owner' }));
	expect(await failure(() => applyCatchUp('alpha', plan.id))).toContain(
		'Mailbox operation is locked',
	);
	expect(await fixture.read('runtime/alpha/telegram-123--456.cursor')).toBe(
		String(plan.telegram?.through),
	);
	expect((await skipProgress('alpha'))?.phase).toBe('applying');
	expect(
		await Bun.file(join(fixture.records, `mailboxes/alpha/delivery/${message}.read`)).exists(),
	).toBe(false);
	await unlink(lock);
	await applyCatchUp('alpha', plan.id);
	expect((await skipProgress('alpha'))?.phase).toBe('applied');
	expect(
		await Bun.file(join(fixture.records, `mailboxes/alpha/delivery/${message}.read`)).exists(),
	).toBe(false);
}, 15_000);

test('changed Telegram identity refuses a preview without moving either cursor', async () => {
	const root = await telegram();
	const { catchUp } = await prepareCatchUp('alpha', 1);
	await writeFile(
		join(root, 'telegram.json'),
		JSON.stringify({ botToken: '999:changed', chatId: '-456', allowedUserIds: ['1'] }),
	);
	expect(await failure(() => applyCatchUp('alpha', catchUp.id))).toContain(
		'Telegram source changed',
	);
	expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(false);
	expect(
		await Bun.file(join(fixture.records, 'runtime/alpha/telegram-123--456.cursor')).exists(),
	).toBe(false);
	expect(await skipProgress('alpha')).toBeUndefined();
});

test('a changed retained source and malformed own plan refuse before creating recovery intent', async () => {
	const root = await telegram();
	const { catchUp } = await prepareCatchUp('alpha', 1);
	const path = join(root, 'telegram-state/123/-456/events.json');
	const value = JSON.parse(await readFile(path, 'utf8')) as { events: RoomEvent[] };
	const first = value.events[0];
	if (!first) throw new Error('Missing positive source control');
	first.text += ' CHANGED';
	await writeFile(path, JSON.stringify(value));
	expect(await failure(() => applyCatchUp('alpha', catchUp.id))).toContain(
		'Historical source changed',
	);
	expect(await skipProgress('alpha')).toBeUndefined();
	await writeFile(
		join(fixture.records, `runtime/alpha/checkpoint-skips/${catchUp.id}.json`),
		'{"version":1}',
	);
	expect((await failure(() => applyCatchUp('alpha', catchUp.id))).length).toBeGreaterThan(0);
	expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(false);
});
