import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { checkpointHash, parseCheckpointPackage } from '../src/checkpoint-package-model.ts';
import { sendHuman } from '../src/local-room-access.ts';
import { optionalText } from '../src/mail-files.ts';
import { statePath } from '../src/mail-read.ts';
import { sendMessage } from '../src/mailbox.ts';
import { newRecord } from '../src/store.ts';
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

async function run(...args: string[]) {
	const result = await fixture.run(['--checkpoint', ...args], 'alpha');
	expect({ code: result.code, error: result.error }).toEqual({ code: 0, error: '' });
	return JSON.parse(result.out) as {
		receipt: string;
		changed: boolean;
		more: boolean;
		package?: { phase: string };
	};
}

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const)
	for (const scenario of [
		'current',
		'obsolete',
		'unverifiable',
		'unknown',
		'rest-ended',
		'rest-ended-current',
		'rest-ended-obsolete',
	] as const)
		test(`${provider} replays and acknowledges frozen ${scenario} notice without rewriting it`, async () => {
			await Bun.write(
				join(fixture.records, 'alpha.json'),
				JSON.stringify(newRecord('alpha', fixture.root, provider)),
			);
			if (scenario !== 'unverifiable')
				await initializeActivity('alpha', 'test-launch', provider);
			const confirmation = randomUUID();
			if (scenario === 'rest-ended-current' || scenario === 'rest-ended-obsolete')
				await Bun.write(
					join(fixture.records, 'runtime/alpha/rest.json'),
					JSON.stringify({
						id: scenario === 'rest-ended-current' ? confirmation : randomUUID(),
						mode: 'awake',
						board: '',
						through: 0,
						nonce: 'test-launch',
						resume: false,
						reason: 'Synthetic rest episode',
					}),
				);
			const id = await sendMessage('alpha', 'alpha', 'Generated fixture reminder', {
				system: scenario.startsWith('rest-ended')
					? {
							purpose: 'rest-ended',
							nonce: 'test-launch',
							confirmation,
							previousActivityNonce: scenario === 'rest-ended' ? null : 'predecessor',
						}
					: {
							purpose: 'rest-nudge',
							nonce: 'test-launch',
							idleSince: new Date().toISOString(),
						},
			});
			if (scenario === 'obsolete') await initializeActivity('alpha', 'successor', provider);
			const mailPath = join(fixture.records, 'mailboxes/alpha/inbox', `${id}.md`);
			if (scenario === 'unknown')
				await Bun.write(
					mailPath,
					(await Bun.file(mailPath).text()).replace('"rest-nudge"', '"future-purpose"'),
				);
			const body = await Bun.file(mailPath).text();
			await sendHuman('Cursor positive control');
			const first = await run();
			const raw = await fixture.read('runtime/alpha/checkpoint-package.json');
			const state = await fixture.read('runtime/alpha/checkpoint.json');
			const frozen = parseCheckpointPackage(raw);
			const expectedStatus =
				scenario === 'unknown' || scenario === 'rest-ended'
					? 'unverifiable'
					: scenario === 'rest-ended-current'
						? 'current'
						: scenario === 'rest-ended-obsolete'
							? 'obsolete'
							: scenario;
			expect(frozen.pages[0]?.completeMail[0]).toMatchObject({
				id,
				noticeStatus: expectedStatus,
			});
			expect(checkpointHash(frozen)).toBe(
				(JSON.parse(state) as { current: { sha256: string } }).current.sha256,
			);
			// Each CLI call is a fresh process loading the persisted package, as after an upgrade.
			expect((await run()).receipt).toBe(first.receipt);
			await run('manifest');
			expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(state);
			expect(await optionalText(statePath('alpha', id, 'read'))).toBeUndefined();
			const final = await run(first.receipt);
			expect(final.package?.phase).toBe('final');
			expect(await optionalText(statePath('alpha', id, 'read'))).toBeDefined();
			expect(
				await optionalText(join(fixture.records, 'runtime/alpha/room.cursor')),
			).toBeUndefined();
			const quiet = await run(final.receipt);
			expect(quiet.changed).toBe(false);
			expect(quiet.more).toBe(false);
			expect(await fixture.read('runtime/alpha/room.cursor')).toBe('1');
			expect(await fixture.read('runtime/alpha/checkpoint-package.json')).toBe(raw);
			expect(await Bun.file(mailPath).text()).toBe(body);
		});

test('malformed notice metadata and unexpected header fields still fail closed', async () => {
	await sendMessage('beta', 'alpha', 'Ordinary mail positive control');
	await run();
	const raw = await fixture.read('runtime/alpha/checkpoint-package.json');
	const packet = parseCheckpointPackage(raw);
	expect(checkpointHash(packet)).toBe(checkpointHash(JSON.parse(raw) as unknown));
	const header = packet.pages[0]?.completeMail[0];
	if (!header) throw new Error('Missing positive control');
	for (const extra of [
		{ noticeStatus: 'unknown' },
		{
			systemNotice: {
				purpose: 'rest-nudge',
				nonce: 'bad\nnonce',
				idleSince: new Date().toISOString(),
			},
		},
		{ systemNotice: { purpose: 'future-purpose' } },
		{ unexpected: true },
	]) {
		const modified = structuredClone(packet);
		const page = modified.pages[0];
		if (!page) throw new Error('Missing positive control page');
		page.completeMail[0] = { ...header, ...extra } as typeof header;
		expect(() => parseCheckpointPackage(JSON.stringify(modified))).toThrow(
			'Invalid frozen checkpoint package',
		);
	}
});

test('notice fragments remain unread until their completing page is acknowledged', async () => {
	const id = await sendMessage('alpha', 'alpha', '界😀'.repeat(10000), {
		system: {
			purpose: 'rest-nudge',
			nonce: 'test-launch',
			idleSince: new Date().toISOString(),
		},
	});
	let batch = await run();
	const raw = await fixture.read('runtime/alpha/checkpoint-package.json');
	const frozen = parseCheckpointPackage(raw);
	expect(frozen.pages.length).toBeGreaterThan(1);
	for (const page of frozen.pages) {
		expect(await optionalText(statePath('alpha', id, 'read'))).toBeUndefined();
		expect(batch.receipt).toBe(page.receipt);
		batch = await run(batch.receipt);
	}
	expect(batch.package?.phase).toBe('final');
	expect(await optionalText(statePath('alpha', id, 'read'))).toBeDefined();
	expect((await run(batch.receipt)).more).toBe(false);
	expect(await fixture.read('runtime/alpha/checkpoint-package.json')).toBe(raw);
});

test('changing accepted notice metadata still rejects the receipt without read coverage', async () => {
	const id = await sendMessage('alpha', 'alpha', 'Frozen reminder', {
		system: {
			purpose: 'rest-nudge',
			nonce: 'test-launch',
			idleSince: new Date().toISOString(),
		},
	});
	const first = await run();
	const state = await fixture.read('runtime/alpha/checkpoint.json');
	const packet = parseCheckpointPackage(
		await fixture.read('runtime/alpha/checkpoint-package.json'),
	);
	const header = packet.pages[0]?.completeMail[0];
	if (!header) throw new Error('Missing notice header');
	header.noticeStatus = 'obsolete';
	await Bun.write(
		join(fixture.records, 'runtime/alpha/checkpoint-package.json'),
		JSON.stringify(packet),
	);
	const result = await fixture.run(['--checkpoint', first.receipt], 'alpha');
	expect(result.code).toBe(1);
	expect(result.error).toContain('Frozen checkpoint package changed');
	expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(state);
	expect(await optionalText(statePath('alpha', id, 'read'))).toBeUndefined();
});

test('a package emitted and rejected by 458aaf1 recovers with its original receipts and bytes', async () => {
	const retained = JSON.parse(
		await Bun.file(
			new URL('./fixtures/checkpoint-notice-458aaf1.fixture', import.meta.url),
		).text(),
	) as { writer: string; packet: string; state: string };
	expect(retained.writer).toBe('458aaf1972f6ea7f1b38aba506629c438cdbe8ed');
	const packet = parseCheckpointPackage(retained.packet);
	const page = packet.pages[0];
	if (!page) throw new Error('Missing old-writer page');
	const payload = page.payload.mail as { messages: { header: { id: string }; text: string }[] };
	const message = payload.messages[0];
	if (!message) throw new Error('Missing old-writer notice');
	const mailPath = join(fixture.records, 'mailboxes/alpha/inbox', `${message.header.id}.md`);
	await Bun.write(mailPath, message.text);
	await Bun.write(
		join(fixture.records, 'runtime/alpha/checkpoint-package.json'),
		retained.packet,
	);
	await Bun.write(join(fixture.records, 'runtime/alpha/checkpoint.json'), retained.state);
	expect((await run()).receipt).toBe(page.receipt);
	expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(retained.state);
	expect(await optionalText(statePath('alpha', message.header.id, 'read'))).toBeUndefined();
	const final = await run(page.receipt);
	expect(final.receipt).toBe(packet.finalReceipt);
	expect(await optionalText(statePath('alpha', message.header.id, 'read'))).toBeDefined();
	const quiet = await run(final.receipt);
	expect(quiet.changed).toBe(false);
	expect(quiet.more).toBe(false);
	expect(await fixture.read('runtime/alpha/checkpoint-package.json')).toBe(retained.packet);
	expect(await Bun.file(mailPath).text()).toBe(message.text);
});
