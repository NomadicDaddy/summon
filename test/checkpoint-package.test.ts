import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Hold } from '../src/mail-attention.ts';

import {
	checkpointHash,
	type CheckpointPackage,
	type PackageItem,
} from '../src/checkpoint-package-model.ts';
import { sendHuman } from '../src/local-room-access.ts';
import { appendLocalEvent } from '../src/local-room.ts';
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
interface Batch {
	receipt: string;
	changed: boolean;
	more: boolean;
	warning?: string;
	package?: {
		id: string;
		phase: string;
		pages: number;
		forMe: number;
		nextForMePage: number | null;
	};
	room?: { events: { id: number; text: string }[] };
	fragments?: {
		source: string;
		id: string;
		text: string;
		offset: number;
		end: number;
		size: number;
	}[];
}
async function run(token?: string) {
	const result = await fixture.run(token ? ['--checkpoint', token] : ['--checkpoint'], 'alpha');
	expect({ code: result.code, error: result.error }).toEqual({ code: 0, error: '' });
	expect(Buffer.byteLength(result.out)).toBeLessThan(34000);
	return JSON.parse(result.out) as Batch;
}
async function packet() {
	return JSON.parse(
		await fixture.read('runtime/alpha/checkpoint-package.json'),
	) as CheckpointPackage;
}

test('frozen inventory covers actual replies, quoted controls and all pages before cursor commit', async () => {
	const own = await appendLocalEvent({
		sender: { kind: 'agent', id: 'alpha' },
		text: 'Question',
		replyTo: null,
		source: 'local',
	});
	await appendLocalEvent({
		sender: { kind: 'agent', id: 'beta' },
		text: 'Reply without mention',
		replyTo: own.id,
		source: 'local',
	});
	await appendLocalEvent({
		sender: { kind: 'agent', id: 'beta' },
		text: '> @alpha quoted example',
		replyTo: null,
		source: 'local',
	});
	for (let i = 0; i < 40; i++) await sendHuman(`Exact human ${i}: ${'x'.repeat(1000)}`);
	const first = await run();
	expect(first.room?.events[0]?.text).toBe('Question');
	expect(first.package?.nextForMePage).toBe(2);
	const frozen = await packet();
	const inventory = JSON.parse(
		(await fixture.run(['--checkpoint', 'manifest'], 'alpha')).out,
	) as { items: PackageItem[]; next: string };
	expect(inventory.items[1]?.forMe).toBe(true);
	expect(inventory.items[2]?.forMe).toBe(false);
	expect(inventory.next).toBe('20');
	const premature = await fixture.run(['--checkpoint', frozen.finalReceipt], 'alpha');
	expect(premature.error).toContain('Unknown checkpoint receipt');
	expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(false);
	await sendHuman('Arrival outside the package');
	let next = first;
	let delivered = 0;
	while (next.package?.phase === 'page') {
		delivered += next.room?.events.length ?? 0;
		expect((await run()).room).toEqual(next.room);
		next = await run(next.receipt);
	}
	expect(delivered).toBe(43);
	expect(next.package?.phase).toBe('final');
	expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(false);
	const arrived = await run(next.receipt);
	expect(await fixture.read('runtime/alpha/room.cursor')).toBe('43');
	expect(arrived.room?.events.map((event) => event.text)).toEqual([
		'Arrival outside the package',
	]);
});

test('oversized escaped Unicode is reconstructed exactly; manifest and header never mark mail read', async () => {
	const id = await sendMessage('beta', 'alpha', '界😀\\"\u0001'.repeat(9000));
	let next = await run();
	const frozen = await packet();
	const item = frozen.items.find((entry) => entry.source === 'mail');
	if (!item) throw new Error('Missing mail manifest positive control.');
	expect(item.parts).toBeGreaterThan(2);
	await fixture.run(['--checkpoint', 'manifest'], 'alpha');
	const marker = join(fixture.records, 'mailboxes/alpha/delivery', `${id}.read`);
	expect(await Bun.file(marker).exists()).toBe(false);
	let text = '';
	let offset = 0;
	while (next.package?.phase === 'page') {
		for (const fragment of next.fragments ?? []) {
			expect(fragment.id).toBe(id);
			expect(fragment.offset).toBe(offset);
			expect(fragment.text).not.toContain('\ufffd');
			text += fragment.text;
			offset = fragment.end;
		}
		next = await run(next.receipt);
		if (next.changed) expect(await Bun.file(marker).exists()).toBe(false);
	}
	expect(offset).toBe(item.bytes);
	const restored: unknown = JSON.parse(text);
	expect(checkpointHash(restored)).toBe(item.sha256);
	expect(await Bun.file(marker).exists()).toBe(true);
	expect((await run(next.receipt)).more).toBe(false);
});

test('immutable orphan publication recovers after process restart; changed package fails closed', async () => {
	await sendHuman('Original snapshot');
	const first = await run();
	const state = await fixture.read('runtime/alpha/checkpoint.json');
	await unlink(join(fixture.records, 'runtime/alpha/checkpoint.json'));
	await sendHuman('After publication');
	expect((await run()).receipt).toBe(first.receipt);
	const frozen = await packet();
	frozen.createdAt = 'tampered';
	await writeFile(
		join(fixture.records, 'runtime/alpha/checkpoint-package.json'),
		JSON.stringify(frozen),
	);
	const rejected = await fixture.run(['--checkpoint', first.receipt], 'alpha');
	expect(rejected.error).toContain('package changed');
	expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(false);
	expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(state);
});

test('old state is rejected without acknowledgement or conversion', async () => {
	await mkdir(join(fixture.records, 'runtime/alpha'), { recursive: true });
	const before = JSON.stringify({ seen: [], mailNext: null, holdNext: null });
	await writeFile(join(fixture.records, 'runtime/alpha/checkpoint.json'), before);
	await sendHuman('Unread positive control');
	const rejected = await fixture.run(['--checkpoint'], 'alpha');
	expect(rejected.error).toContain('reviewed offline migration');
	expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(before);
	expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(false);
});

test('oversized hold decision changes stay outside frozen pages and are delivered next', async () => {
	const hold: Hold = {
		id: randomUUID(),
		agent: 'alpha',
		messageId: randomUUID(),
		sender: 'beta',
		reason: 'Approval boundary',
		proposal: '界'.repeat(15000),
		digest: 'source digest',
		createdAt: new Date().toISOString(),
		decision: 'pending',
		userReference: '',
	};
	const root = join(fixture.records, 'mailboxes/alpha/holds');
	await mkdir(root, { recursive: true });
	const path = join(root, `${hold.id}.json`);
	await writeFile(path, JSON.stringify(hold));
	let batch = await run();
	expect(batch.fragments?.[0]?.source).toBe('hold');
	const changed = { ...hold, decision: 'approve', userReference: 'fixture human decision' };
	await writeFile(path, JSON.stringify(changed));
	let text = '';
	while (batch.package?.phase === 'page') {
		text += (batch.fragments ?? []).map((fragment) => fragment.text).join('');
		batch = await run(batch.receipt);
	}
	expect(JSON.parse(text) as unknown).toEqual(hold);
	expect(await Bun.file(path).text()).toBe(JSON.stringify(changed));
	const next = await run(batch.receipt);
	expect(next.fragments?.[0]?.source).toBe('hold');
	expect(next.package?.id).not.toBe(batch.package?.id);
});

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const)
	test(`${provider} registration uses owner-bound checkpoint pages and final receipt`, async () => {
		await writeFile(
			join(fixture.records, 'alpha.json'),
			JSON.stringify(newRecord('alpha', fixture.root, provider)),
		);
		await sendHuman(`Shared CLI consumer: ${provider}`);
		const first = await run();
		const foreign = await fixture.run(['--checkpoint', first.receipt], 'beta');
		expect(foreign.code).toBe(1);
		const final = await run(first.receipt);
		expect(final.package?.phase).toBe('final');
		expect((await run(final.receipt)).more).toBe(false);
		expect(await fixture.read('runtime/alpha/room.cursor')).toBe('1');
	});

test('a retained empty receipt never consumes a newly frozen page and announces its replay', async () => {
	const empty = await run();
	await sendHuman('Arrived after the empty result');
	const first = await run();
	const replay = await run(empty.receipt);
	expect(replay.receipt).toBe(first.receipt);
	expect(replay.room).toEqual(first.room);
	expect(replay.warning).toContain('replayed, not newly read');
	expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(false);
	const final = await run(replay.receipt);
	expect(final.package?.phase).toBe('final');
	expect((await run(final.receipt)).more).toBe(false);
});
