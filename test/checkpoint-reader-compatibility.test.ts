import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
	checkpointHash,
	checkpointTelegramError,
	parseCheckpointPackage,
} from '../src/checkpoint-package-model.ts';
import { checkpointPages } from '../src/checkpoint-package-pages.ts';
import { newRecord } from '../src/store.ts';
import {
	checkpointHash as oldHash,
	parseCheckpointPackage as oldReader,
	parseCheckpointState as oldState,
} from './fixtures/checkpoint-reader-ae53f97.ts';
import { telegramHarness } from './fixtures/telegram-harness.ts';
import { persistedOutage } from './fixtures/telegram-outage.ts';

interface Batch {
	receipt: string;
	package: { id: string; phase: string; page: number };
	telegramFresh?: boolean;
	telegramRefreshError?: string;
}

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const)
	test(`${provider} outage writer stays readable and hash-identical for ae53f97`, async () => {
		const h = await telegramHarness();
		try {
			await writeFile(
				join(h.root, 'test-agent.json'),
				JSON.stringify(newRecord('test-agent', h.root, provider)),
			);
			// A persistent outage that this first failed read announces, freezing a package with its notice.
			await persistedOutage(h.root);
			const result = await h.invoke([], 'timeout', 'test-agent', '42', '--checkpoint');
			expect(result.code).toBe(0);
			const batch = JSON.parse(result.out) as Batch;
			const packetPath = join(h.root, 'runtime/test-agent/checkpoint-package.json');
			const raw = await readFile(packetPath, 'utf8');
			const current = parseCheckpointPackage(raw);
			const old = oldReader(raw);
			expect(current.telegramRefreshError).toBeUndefined();
			expect(checkpointTelegramError(current)).toBe('The Telegram request timed out.');
			expect(oldHash(old)).toBe(checkpointHash(current));
			expect(old.pages[0]?.receipt).toBe(batch.receipt);
			// Positive baseline and negative envelope-extension controls exercise the frozen parser.
			const baseline = {
				...current,
				pages: current.pages.map((p) => ({ ...p, payload: {} })),
			};
			expect(oldReader(JSON.stringify(baseline)).id).toBe(current.id);
			const incompatible = { ...current, telegramRefreshError: 'retained old envelope' };
			expect(() => oldReader(JSON.stringify(incompatible))).toThrow('Invalid frozen');
			const retainedRaw = JSON.stringify(incompatible);
			const retained = parseCheckpointPackage(retainedRaw);
			expect(checkpointTelegramError(retained)).toBe('retained old envelope');
			expect(checkpointHash(retained)).toBe(checkpointHash(incompatible));
			const manifest = JSON.parse(
				(await h.invoke(['manifest'], 'success', 'test-agent', '42', '--checkpoint')).out,
			) as { position: { receiptSha256: string; phase: string; page: number } };
			expect(manifest.position).toEqual({
				receiptSha256: checkpointHash(batch.receipt),
				phase: 'page',
				page: 1,
			});
			expect(await readFile(packetPath, 'utf8')).toBe(raw);
			// Retained extended envelopes remain byte/hash stable when read by the current CLI.
			const statePath = join(h.root, 'runtime/test-agent/checkpoint.json');
			expect(oldState(await readFile(statePath, 'utf8')).current?.sha256).toBe(oldHash(old));
			const state = JSON.parse(await readFile(statePath, 'utf8')) as {
				current: { sha256: string };
			};
			state.current.sha256 = checkpointHash(incompatible);
			await writeFile(packetPath, retainedRaw);
			await writeFile(statePath, JSON.stringify(state));
			const replay = JSON.parse(
				(await h.invoke([], 'success', 'test-agent', '42', '--checkpoint')).out,
			) as Batch;
			expect(replay.receipt).toBe(batch.receipt);
			expect(replay.telegramRefreshError).toBe('retained old envelope');
			expect(await readFile(packetPath, 'utf8')).toBe(retainedRaw);
			const final = JSON.parse(
				(await h.invoke([batch.receipt], 'success', 'test-agent', '42', '--checkpoint'))
					.out,
			) as Batch;
			expect(final.package.phase).toBe('final');
			expect(final.telegramFresh).toBe(false);
			expect(final.telegramRefreshError).toBe('retained old envelope');
		} finally {
			await h.dispose();
		}
	}, 30_000);

test('outage metadata participates in page sizing and invalid retained metadata fails closed', () => {
	const warning = '\u0001'.repeat(512);
	const sources = { room: { from: 0, through: 0 }, holds: {} };
	const { pages } = checkpointPages(
		Array.from({ length: 8 }, (_, index) => ({
			source: 'mail-error' as const,
			id: String(index),
			forMe: true,
			presentation: 'exact' as const,
			value: { id: String(index), error: '界'.repeat(7500) },
		})),
		{
			roomThrough: 0,
			telegramThrough: 0,
			startedAt: null,
			paused: false,
			sources,
			telegramRefreshError: warning,
		},
	);
	expect(pages.length).toBeGreaterThan(1);
	for (const page of pages) {
		expect(Buffer.byteLength(JSON.stringify(page.payload))).toBeLessThanOrEqual(30_000);
		expect(page.payload.telegramRefreshError).toBe(warning);
	}
	const packet = {
		version: 1,
		owner: 'alpha',
		id: '11111111-1111-4111-8111-111111111111',
		createdAt: 'fixture',
		items: [],
		pages,
		finalReceipt: '22222222-2222-4222-8222-222222222222',
		sources,
	};
	expect(checkpointHash(oldReader(JSON.stringify(packet)))).toBe(checkpointHash(packet));
	const first = pages[0];
	if (!first) throw new Error('Missing positive-control page.');
	first.payload.telegramRefreshError = { secret: 'must not appear in diagnostic' };
	expect(() => parseCheckpointPackage(JSON.stringify(packet))).toThrow(
		'Invalid frozen checkpoint package. Nothing was acknowledged.',
	);
});
