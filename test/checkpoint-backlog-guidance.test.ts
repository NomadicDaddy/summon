import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { CheckpointPackage, CheckpointState } from '../src/checkpoint-package-model.ts';

import { checkpointOutput, checkpointPageFits } from '../src/checkpoint-output.ts';
import { checkpointText } from '../src/checkpoint-text.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

function packageOf(pages: number, payload: Record<string, unknown> = { room: { events: [] } }) {
	const packet: CheckpointPackage = {
		version: 1,
		owner: 'alpha',
		id: randomUUID(),
		createdAt: new Date().toISOString(),
		items: [],
		pages: Array.from({ length: pages }, () => ({
			receipt: randomUUID(),
			payload,
			completeMail: [],
		})),
		finalReceipt: randomUUID(),
		sources: { room: { from: 0, through: 0 }, holds: {} },
	};
	return packet;
}

const stateAt = (packet: CheckpointPackage, page: number): CheckpointState => ({
	version: 2,
	current: { id: packet.id, sha256: 'a'.repeat(64), page },
	seenHolds: {},
});

const advice = (output: Record<string, unknown>) => output.catchUpAdvice;

test('three pages carry no catch-up advice, in JSON or text', () => {
	const packet = packageOf(3);
	for (let page = 0; page < 3; page++) {
		const output = checkpointOutput(packet, stateAt(packet, page), false, false);
		expect(advice(output)).toBeUndefined();
		expect(checkpointText(output, true)).not.toContain('catchUpAdvice');
	}
});

test('four pages carry the advice on every page, in JSON and text, but not on the final receipt', () => {
	const packet = packageOf(4);
	for (let page = 0; page < 4; page++) {
		const output = checkpointOutput(packet, stateAt(packet, page), false, false);
		expect(String(advice(output))).toContain('This package has 4 pages and 0 items.');
		const text = checkpointText(output, true);
		expect(text).toContain('catchUpAdvice (');
		expect(text).toContain('summon --checkpoint catch-up keeps a recent tail');
	}
	const final = checkpointOutput(packet, stateAt(packet, 4), false, false);
	expect(final.package.phase).toBe('final');
	expect(advice(final)).toBeUndefined();
});

test('replayed pages keep the advice, so a returning seat still sees it', () => {
	const packet = packageOf(5);
	for (const replay of ['issued', 'acknowledged'] as const) {
		const output = checkpointOutput(packet, stateAt(packet, 1), false, true, undefined, replay);
		expect(String(advice(output))).toContain('This package has 5 pages and 0 items.');
		expect(output.warning).toBeDefined();
	}
});

test('the advice is a pointer only: preview, read-back, explicit apply, and refusal handling', () => {
	const packet = packageOf(4);
	const text = String(advice(checkpointOutput(packet, stateAt(packet, 0), false, false)));
	for (const part of [
		'summon --checkpoint catch-up keeps a recent tail',
		'summon --checkpoint catch-up list <plan-id>',
		'read each one with the exact read command its entry gives',
		'summon --checkpoint catch-up apply <plan-id>',
		'recorded as skipped, never as read, handled or approved',
		'your mail keeps its own state',
		'Telegram refresh is incomplete',
		'do not retry in a loop or work around it',
		'read this page and pass its receipt',
	])
		expect(text).toContain(part);
	// No abbreviated read command a reader could run literally and get a usage error.
	expect(text).not.toContain('catch-up show <plan-id>');
	expect(text).not.toContain('--room show');
	// The page still carries its own ordinary receipt instruction alongside the advice.
	expect(
		checkpointOutput(packet, stateAt(packet, 0), false, false).package.instruction,
	).toContain('Read this entire page before passing its receipt.');
});

test('page sizing reserves room for the advice in both formats', () => {
	// The largest single string body checkpointPageFits accepts, sized with the same Telegram error
	// the page is then delivered with, as a package capture does.
	const error = 'refresh failed';
	let low = 0;
	let high = 40_000;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (checkpointPageFits({ body: 'x'.repeat(middle) }, error)) low = middle;
		else high = middle - 1;
	}
	expect(low).toBeGreaterThan(0);
	const packet = packageOf(9_999, { body: 'x'.repeat(low) });
	const output = checkpointOutput(packet, stateAt(packet, 0), false, true, error, 'issued');
	expect(advice(output)).toBeDefined();
	expect(Buffer.byteLength(`${JSON.stringify(output)}\n`)).toBeLessThanOrEqual(28_000);
	expect(Buffer.byteLength(`${checkpointText(output, true)}\n`)).toBeLessThanOrEqual(24_000);
});

test('a real deep package shows the advice and creates no catch-up plan or receipt movement', async () => {
	const h = await mailHarness();
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = h.records;
	try {
		// Byte pressure: each post fills most of a page.
		for (let index = 0; index < 14; index++)
			expect(
				(await h.run(['--room', 'send', `message ${index}: ${'x'.repeat(3900)}`], 'beta'))
					.code,
			).toBe(0);
		const first = JSON.parse((await h.run(['--checkpoint'], 'alpha')).out) as {
			catchUpAdvice?: string;
			package: { pages: number; page: number };
		};
		expect(first.package.pages).toBeGreaterThan(3);
		expect(first.package.page).toBe(1);
		expect(first.catchUpAdvice).toContain(
			`This package has ${String(first.package.pages)} pages and`,
		);
		const text = (await h.run(['--checkpoint', '--format', 'text'], 'alpha')).out;
		expect(text).toContain('catchUpAdvice (');
		expect(
			await Bun.file(join(h.records, 'runtime/alpha/checkpoint-catch-up.json')).exists(),
		).toBe(false);
		expect(await h.read('runtime/alpha/checkpoint.json')).toContain('"page":0');
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await h.dispose();
	}
}, 60_000);
