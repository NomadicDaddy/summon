import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CheckpointPackage } from '../src/checkpoint-package-model.ts';

import { confirmGuidance } from '../src/mail-confirm-guidance.ts';
import { sendMessage } from '../src/mailbox.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

// mail-confirm-receipt-guidance: a refused confirmation names the one recovery that applies, from
// the caller's own state, and writes nothing. Morgan's controls (mail 74793947) are each a case.

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

const statePath = (): string => join(fixture.records, 'runtime', 'alpha', 'checkpoint.json');
const packagePath = (): string =>
	join(fixture.records, 'runtime', 'alpha', 'checkpoint-package.json');
const delivery = (id: string, state: string): string =>
	join(fixture.records, 'mailboxes', 'alpha', 'delivery', `${id}.${state}`);

async function snapshot(id: string): Promise<(string | null)[]> {
	const paths = [statePath(), packagePath(), delivery(id, 'read'), delivery(id, 'confirmed')];
	return Promise.all(paths.map((path) => readFile(path, 'utf8').catch(() => null)));
}

/** Confirms as alpha, asserting a refusal that wrote nothing; returns its message. */
async function refused(id: string): Promise<string> {
	const before = await snapshot(id);
	const run = await fixture.run(['--mail', 'confirm', id, 'understood'], 'alpha');
	expect(run.code).toBe(1);
	expect(await snapshot(id)).toEqual(before);
	expect(run.error).toContain('Read the entire request before confirming.');
	return run.error;
}

async function checkpoint(receipt?: string): Promise<{ receipt: string }> {
	const run = await fixture.run(receipt ? ['--checkpoint', receipt] : ['--checkpoint'], 'alpha');
	expect(run.code).toBe(0);
	return JSON.parse(run.out) as { receipt: string };
}

async function frozen(): Promise<CheckpointPackage> {
	return JSON.parse(await readFile(packagePath(), 'utf8')) as CheckpointPackage;
}

function completingPage(packet: CheckpointPackage, id: string): number {
	return packet.pages.findIndex((page) => page.completeMail.some((mail) => mail.id === id));
}

test('a body on the current page names that page and its receipt, and confirming works once it is passed', async () => {
	const id = await sendMessage('beta', 'alpha', 'Please confirm this request.');
	const first = await checkpoint();
	const message = await refused(id);
	expect(message).toContain('checkpoint page 1 of');
	expect(message).toContain('Run summon --checkpoint without a receipt to replay that page');
	expect(message).toContain(`summon --checkpoint ${first.receipt}`);
	expect(message).not.toContain('Please confirm this request.');
	await checkpoint(first.receipt);
	expect((await fixture.run(['--mail', 'confirm', id, 'understood'], 'alpha')).code).toBe(0);
});

test('a body completing on a later page names the page and prints no undelivered receipt', async () => {
	// Pages carry the newest mail first, so the target is sent first to land on a later page.
	const target = await sendMessage('beta', 'alpha', `target ${'y'.repeat(18_000)}`);
	for (let index = 0; index < 3; index++)
		await sendMessage('beta', 'alpha', `filler ${String(index)} ${'x'.repeat(18_000)}`);
	await checkpoint();
	const packet = await frozen();
	const page = completingPage(packet, target);
	expect(page).toBeGreaterThan(0);
	const message = await refused(target);
	expect(message).toContain(`Continue summon --checkpoint from page 1`);
	expect(message).toContain(`page ${String(page + 1)}'s receipt is accepted`);
	for (const later of packet.pages.slice(1)) expect(message).not.toContain(later.receipt);
	expect(message).not.toContain(packet.finalReceipt);
});

test('a body fragmented over pages names its span, not just the completing page', async () => {
	const id = await sendMessage('beta', 'alpha', `big ${'z'.repeat(70_000)}`);
	await checkpoint();
	const packet = await frozen();
	const item = packet.items.find((entry) => entry.source === 'mail' && entry.id === id);
	if (item === undefined) throw new Error('the fragmented mail is not in the package');
	expect(item.lastPage).toBeGreaterThan(item.firstPage);
	const message = await refused(id);
	expect(message).toContain(
		`spread over checkpoint pages ${String(item.firstPage + 1)} to ${String(item.lastPage + 1)}`,
	);
});

test('a partial read-self names the next offset, and a malformed or out-of-range one falls back to 0', async () => {
	const id = await sendMessage('beta', 'alpha', 'w'.repeat(5000));
	const head = await fixture.run(
		['--mail', 'read-self', id, '--offset', '0', '--limit', '100'],
		'alpha',
	);
	expect(head.code).toBe(0);
	expect(await refused(id)).toContain(`--offset 100 --limit 32768`);
	for (const bad of ['abc', '99999', '-5', '1.5']) {
		await writeFile(delivery(id, 'offset'), bad);
		expect(await refused(id)).toContain(`read-self ${id} --offset 0 --limit 32768`);
	}
});

test('a request never delivered names read-self from the start', async () => {
	const id = await sendMessage('beta', 'alpha', 'Never read.');
	expect(await refused(id)).toContain(`summon --mail read-self ${id} --offset 0 --limit 32768`);
});

test('malformed, foreign, out-of-range and final-phase state give no page hint', async () => {
	const id = await sendMessage('beta', 'alpha', 'State checks.');
	const first = await checkpoint();
	const goodState = await readFile(statePath(), 'utf8');
	const goodPackage = await readFile(packagePath(), 'utf8');
	const expectFallback = async (): Promise<void> => {
		const message = await refused(id);
		expect(message).toContain(`read-self ${id} --offset 0`);
		expect(message).not.toContain(first.receipt);
	};
	await writeFile(statePath(), '{not json');
	await expectFallback();
	await writeFile(statePath(), goodState);
	const foreign = JSON.parse(goodPackage) as CheckpointPackage;
	await writeFile(packagePath(), JSON.stringify({ ...foreign, owner: 'beta' }));
	await expectFallback();
	await writeFile(packagePath(), goodPackage);
	const state = JSON.parse(goodState) as { current: { page: number } };
	const pages = (JSON.parse(goodPackage) as CheckpointPackage).pages.length;
	for (const page of [pages, pages + 3]) {
		state.current.page = page;
		await writeFile(statePath(), JSON.stringify(state));
		await expectFallback();
	}
});

test('a state that changes while the package is read drops the page hint', async () => {
	const id = await sendMessage('beta', 'alpha', 'Racing state.');
	await checkpoint();
	const raw = await readFile(statePath(), 'utf8');
	let reads = 0;
	const read = async (path: string): Promise<string | undefined> => {
		const text = await readFile(path, 'utf8').catch(() => undefined);
		if (path === statePath() && (reads += 1) > 1) return `${raw} `;
		return text;
	};
	const message = await confirmGuidance('alpha', id, 13, undefined, read);
	expect(message).toContain(`read-self ${id} --offset 0`);
	expect(message).not.toContain('checkpoint page');
});

test('an expired package whose id or content no longer matches the state gives no page hint', async () => {
	const id = await sendMessage('beta', 'alpha', 'Expired package.');
	const first = await checkpoint();
	const good = await frozen();
	for (const expired of [
		{ ...good, id: '00000000-0000-4000-8000-000000000000' },
		{ ...good, finalReceipt: '00000000-0000-4000-8000-000000000001' },
	]) {
		await writeFile(packagePath(), JSON.stringify(expired));
		const message = await refused(id);
		expect(message).toContain(`read-self ${id} --offset 0`);
		expect(message).not.toContain(first.receipt);
	}
});

test('a read-self that stops inside a UTF-8 character names its character-boundary end, and confirming works at the last byte', async () => {
	const id = await sendMessage('beta', 'alpha', 'é'.repeat(3000));
	// Past the ASCII headers, inside the two-byte body.
	const limits = [1000, 1001];
	const ends: number[] = [];
	// Limits rise, so the recorded offset ends at the second read's end.
	for (const limit of limits) {
		const run = await fixture.run(
			['--mail', 'read-self', id, '--offset', '0', '--limit', String(limit)],
			'alpha',
		);
		expect(run.code).toBe(0);
		ends.push((JSON.parse(run.out) as { end: number }).end);
	}
	// One of two adjacent limits lands inside a two-byte character and is trimmed back.
	expect(ends.some((end, index) => end === (limits[index] ?? 0) - 1)).toBe(true);
	const end = ends[1] ?? 0;
	expect(await refused(id)).toContain(`--offset ${String(end)} --limit 32768`);
	let next = end;
	for (;;) {
		const run = await fixture.run(
			['--mail', 'read-self', id, '--offset', String(next), '--limit', '32768'],
			'alpha',
		);
		expect(run.code).toBe(0);
		const chunk = JSON.parse(run.out) as { end: number; size: number };
		next = chunk.end;
		if (next >= chunk.size) break;
	}
	expect((await fixture.run(['--mail', 'confirm', id, 'understood'], 'alpha')).code).toBe(0);
});
