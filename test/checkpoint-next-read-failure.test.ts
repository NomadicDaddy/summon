import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { newRecord } from '../src/store.ts';
import { telegramHarness, update } from './fixtures/telegram-harness.ts';
import { persistedOutage } from './fixtures/telegram-outage.ts';

interface Batch {
	receipt: string;
	changed: boolean;
	more: boolean;
	telegramRefreshError?: string;
	telegramFresh?: boolean;
	transportWarning?: string;
	package?: { id: string; phase: string };
	room?: { events: { text: string }[] };
}

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const)
	test(`${provider} continues local checkpoints during outage and recovers remote updates`, async () => {
		const h = await telegramHarness();
		try {
			await writeFile(
				join(h.root, 'test-agent.json'),
				JSON.stringify(newRecord('test-agent', h.root, provider)),
			);
			const invoke = (receipt?: string, mode = 'success') =>
				h.invoke(receipt ? [receipt] : [], mode, 'test-agent', '42', '--checkpoint');
			await writeFile(join(h.root, 'updates.json'), JSON.stringify([update(42, 'Original')]));
			const first = JSON.parse((await invoke()).out) as Batch;
			const final = JSON.parse((await invoke(first.receipt)).out) as Batch;
			expect(final.package?.phase).toBe('final');
			await writeFile(
				join(h.root, 'updates.json'),
				JSON.stringify([update(42, 'Original'), update(43, 'Unread positive control')]),
			);
			// An outage that has outlasted the grace period, so this failure announces at once.
			await persistedOutage(h.root);
			const local = await h.invoke(
				['send', 'Local outage control'],
				'timeout',
				'test-agent',
				'42',
				'--room',
			);
			expect(local.code).toBe(0);
			expect(local.err).toContain('Telegram refresh incomplete');
			const failed = await invoke(final.receipt, 'timeout');
			expect({ code: failed.code, err: failed.err }).toEqual({ code: 0, err: '' });
			const outcome = JSON.parse(failed.out) as Batch;
			expect(outcome).toMatchObject({
				changed: true,
				more: true,
				telegramRefreshError: 'The Telegram request timed out.',
				telegramFresh: false,
			});
			expect(outcome.package?.phase).toBe('page');
			expect(outcome.room?.events.map((event) => event.text)).toEqual([
				expect.stringContaining('Telegram refresh failed:'),
				'Local outage control',
			]);
			expect(failed.out).not.toContain('sensitive token-bearing');
			const replay = JSON.parse((await invoke()).out) as Batch;
			expect(replay).toMatchObject({
				receipt: outcome.receipt,
				telegramFresh: false,
				telegramRefreshError: outcome.telegramRefreshError,
			});
			const manifest = await h.invoke(
				['manifest'],
				'success',
				'test-agent',
				'42',
				'--checkpoint',
			);
			expect(JSON.parse(manifest.out)).toMatchObject({
				telegramFresh: false,
				telegramRefreshError: outcome.telegramRefreshError,
			});
			const cursor = join(h.root, 'runtime/test-agent/telegram-123-456.cursor');
			expect(await readFile(cursor, 'utf8')).toBe('1');
			const localFinal = JSON.parse((await invoke(outcome.receipt, 'network')).out) as Batch;
			expect(localFinal.package?.phase).toBe('final');
			expect(localFinal).toMatchObject({
				telegramFresh: false,
				telegramRefreshError: outcome.telegramRefreshError,
			});
			const quiet = JSON.parse((await invoke(localFinal.receipt, 'network')).out) as Batch;
			expect(quiet).toMatchObject({ changed: false, more: false, telegramFresh: false });
			expect(quiet.telegramRefreshError).toContain('network request failed');
			expect(await readFile(cursor, 'utf8')).toBe('1');
			const recovered = JSON.parse((await invoke()).out) as Batch;
			expect(await readFile(join(h.root, 'runtime/test-agent/room.cursor'), 'utf8')).toBe(
				'3',
			);
			expect(recovered.package?.id).not.toBe(first.package?.id);
			expect(recovered.room?.events.map((event) => event.text)).toEqual([
				'Unread positive control',
				expect.stringContaining('Telegram refresh recovered.'),
			]);
			expect(await readFile(cursor, 'utf8')).toBe('1');
			const recoveredFinal = JSON.parse((await invoke(recovered.receipt)).out) as Batch;
			expect(recoveredFinal.package?.phase).toBe('final');
			expect((JSON.parse((await invoke(recoveredFinal.receipt)).out) as Batch).more).toBe(
				false,
			);
			expect(await readFile(cursor, 'utf8')).toBe('2');
		} finally {
			await h.dispose();
		}
	}, 30_000);

test('a first transient outage stays quiet but still reports its freshness to the caller', async () => {
	const h = await telegramHarness();
	try {
		const failed = await h.invoke([], 'timeout', 'test-agent', '42', '--checkpoint');
		expect(failed.code).toBe(0);
		expect(JSON.parse(failed.out)).toMatchObject({
			changed: false,
			more: false,
			telegramFresh: false,
			telegramRefreshError: 'The Telegram request timed out.',
		});
		expect(failed.out).not.toContain('Telegram refresh failed');
		const recovered = await h.invoke([], 'success', 'test-agent', '42', '--checkpoint');
		expect(recovered.code).toBe(0);
		expect(recovered.out).not.toContain('Telegram refresh recovered');
		const health = join(h.root, 'integrations/telegram-state/123/health.json');
		expect(await readFile(health, 'utf8')).toBe('null');
	} finally {
		await h.dispose();
	}
});

test('first-read outage delivers the operator notice before local quiet', async () => {
	const h = await telegramHarness();
	try {
		await persistedOutage(h.root);
		const failed = await h.invoke([], 'timeout', 'test-agent', '42', '--checkpoint');
		expect(failed.code).toBe(0);
		expect(failed.err).toBe('');
		expect(JSON.parse(failed.out)).toMatchObject({
			changed: true,
			more: true,
			telegramFresh: false,
			telegramRefreshError: 'The Telegram request timed out.',
		});
		expect(await Bun.file(join(h.root, 'runtime/test-agent/room.cursor')).exists()).toBe(false);
		const first = JSON.parse(failed.out) as Batch;
		expect(first.room?.events[0]?.text).toContain('Telegram refresh failed:');
		const final = JSON.parse(
			(await h.invoke([first.receipt], 'timeout', 'test-agent', '42', '--checkpoint')).out,
		) as Batch;
		const quiet = JSON.parse(
			(await h.invoke([final.receipt], 'timeout', 'test-agent', '42', '--checkpoint')).out,
		) as Batch;
		expect(quiet).toMatchObject({ changed: false, more: false, telegramFresh: false });
	} finally {
		await h.dispose();
	}
});

test('outage provenance survives multiple frozen pages after remote recovery', async () => {
	const h = await telegramHarness();
	try {
		for (let index = 0; index < 10; index++) {
			const sent = await h.invoke(
				['send', `${index}: ${'x'.repeat(3500)}`],
				'success',
				'test-agent',
				'42',
				'--room',
			);
			expect(sent.code).toBe(0);
		}
		await persistedOutage(h.root);
		let batch = JSON.parse(
			(await h.invoke([], 'timeout', 'test-agent', '42', '--checkpoint')).out,
		) as Batch;
		const id = batch.package?.id;
		expect(batch.transportWarning).toContain('because the Telegram request failed');
		const interruptedRead = JSON.parse(
			(await h.invoke([], 'success', 'test-agent', '42', '--checkpoint')).out,
		) as Batch;
		expect(interruptedRead).toMatchObject({
			receipt: batch.receipt,
			telegramFresh: false,
			telegramRefreshError: batch.telegramRefreshError,
			transportWarning: batch.transportWarning,
		});
		let pages = 0;
		while (batch.package?.phase === 'page') {
			expect(batch).toMatchObject({
				telegramFresh: false,
				telegramRefreshError: 'The Telegram request timed out.',
			});
			if (pages > 0) expect(batch.transportWarning).toContain('cached-only (request failed)');
			pages++;
			batch = JSON.parse(
				(await h.invoke([batch.receipt], 'success', 'test-agent', '42', '--checkpoint'))
					.out,
			) as Batch;
			expect(batch.package?.id).toBe(id);
		}
		expect(pages).toBeGreaterThan(1);
		expect(batch).toMatchObject({
			telegramFresh: false,
			telegramRefreshError: 'The Telegram request timed out.',
		});
		expect(batch.transportWarning).toContain('cached-only (request failed)');
		const quiet = JSON.parse(
			(await h.invoke([batch.receipt], 'success', 'test-agent', '42', '--checkpoint')).out,
		) as Batch;
		expect(quiet.room?.events[0]?.text).toContain('Telegram refresh recovered.');
		expect(quiet.telegramFresh).toBeUndefined();
		expect(quiet.transportWarning).toBeUndefined();
	} finally {
		await h.dispose();
	}
}, 30_000);

test('unknown receipt is rejected before next-read failure recovery', async () => {
	const h = await telegramHarness();
	try {
		const failed = await h.invoke(
			['11111111-1111-4111-8111-111111111111'],
			'timeout',
			'test-agent',
			'42',
			'--checkpoint',
		);
		expect(failed.code).toBe(1);
		expect(failed.err).toContain('Unknown checkpoint receipt');
		expect(failed.out).toBe('');
		expect(await Bun.file(join(h.root, 'runtime/test-agent/checkpoint.json')).exists()).toBe(
			false,
		);
	} finally {
		await h.dispose();
	}
});

test('changed Telegram source refuses final receipt without mutating checkpoint state', async () => {
	const h = await telegramHarness();
	try {
		await writeFile(join(h.root, 'updates.json'), JSON.stringify([update(42, 'Original')]));
		const first = JSON.parse(
			(await h.invoke([], 'success', 'test-agent', '42', '--checkpoint')).out,
		) as Batch;
		const final = JSON.parse(
			(await h.invoke([first.receipt], 'success', 'test-agent', '42', '--checkpoint')).out,
		) as Batch;
		const statePath = join(h.root, 'runtime/test-agent/checkpoint.json');
		const before = await readFile(statePath, 'utf8');
		await writeFile(
			join(h.root, 'integrations/telegram.json'),
			JSON.stringify({ botToken: '123:fake-test-token', chatId: '999' }),
		);
		const failed = await h.invoke(
			[final.receipt],
			'timeout',
			'test-agent',
			'42',
			'--checkpoint',
		);
		expect(failed.code).toBe(1);
		expect(failed.err).toContain('Telegram source changed during this package');
		expect(failed.out).toBe('');
		expect(await readFile(statePath, 'utf8')).toBe(before);
		expect(await Bun.file(join(h.root, 'runtime/test-agent/room.cursor')).exists()).toBe(false);
	} finally {
		await h.dispose();
	}
});
