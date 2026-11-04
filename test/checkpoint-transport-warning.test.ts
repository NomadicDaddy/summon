import { expect, test } from 'bun:test';

import type { CheckpointPackage, CheckpointState } from '../src/checkpoint-package-model.ts';

import { checkpointOutput, checkpointPageFits } from '../src/checkpoint-output.ts';
import { checkpointText } from '../src/checkpoint-text.ts';
import { TELEGRAM_REFRESH_BUSY_REASON } from '../src/telegram-local-refresh.ts';

const packetId = '11111111-1111-4111-8111-111111111111';
const receipts = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];

function packet(payload: Record<string, unknown> = {}): CheckpointPackage {
	return {
		version: 1,
		owner: 'alpha',
		id: packetId,
		createdAt: 'fixture',
		items: [],
		pages: receipts.map((receipt) => ({
			receipt,
			payload,
			completeMail: [],
		})),
		finalReceipt: '44444444-4444-4444-8444-444444444444',
		sources: { room: { from: 0, through: 0 }, holds: {} },
	};
}

function output(
	page: number,
	error: string,
	replay?: 'issued' | 'acknowledged',
	payload: Record<string, unknown> = {},
) {
	const state: CheckpointState = {
		version: 2,
		seenHolds: {},
		current: { id: packetId, sha256: '0'.repeat(64), page },
	};
	return checkpointOutput(packet(payload), state, false, false, error, replay);
}

test('busy refresh explains coverage once while every page and final stay self-contained', () => {
	const first = output(0, TELEGRAM_REFRESH_BUSY_REASON);
	const replay = output(0, TELEGRAM_REFRESH_BUSY_REASON, 'issued');
	const second = output(1, TELEGRAM_REFRESH_BUSY_REASON);
	const final = output(2, TELEGRAM_REFRESH_BUSY_REASON);
	for (const delivered of [first, replay, second, final]) {
		expect(delivered).toMatchObject({
			telegramFresh: false,
			telegramRefreshError: TELEGRAM_REFRESH_BUSY_REASON,
		});
		expect(checkpointText(delivered, true)).toContain('unseen remote updates may remain');
	}
	expect(first.transportWarning).toContain('poll lock after a short wait');
	expect(replay.transportWarning).toBe(first.transportWarning);
	expect(second.transportWarning).toContain('cached-only (refresh busy)');
	expect(second.transportWarning).not.toContain('poll lock after a short wait');
	expect(final.transportWarning).toBe(second.transportWarning);
});

test('request failure remains distinct from harmless poll contention on every page', () => {
	const error = 'The Telegram request timed out.';
	const first = output(0, error);
	const second = output(1, error);
	const final = output(2, error);
	for (const delivered of [first, second, final]) {
		expect(delivered).toMatchObject({ telegramFresh: false, telegramRefreshError: error });
		expect(delivered.transportWarning).not.toContain('refresh busy');
	}
	expect(first.transportWarning).toContain('the Telegram request failed');
	expect(second.transportWarning).toContain('cached-only (request failed)');
	expect(final.transportWarning).toBe(second.transportWarning);
});

test('page sizing includes the longer first-page warning in JSON and UTF-8 text', () => {
	const payload = (count: number) => ({ room: { events: [{ text: '界'.repeat(count) }] } });
	let low = 0;
	let high = 10_000;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (checkpointPageFits(payload(middle), TELEGRAM_REFRESH_BUSY_REASON)) low = middle;
		else high = middle - 1;
	}
	expect(checkpointPageFits(payload(low), TELEGRAM_REFRESH_BUSY_REASON)).toBe(true);
	expect(checkpointPageFits(payload(low + 1), TELEGRAM_REFRESH_BUSY_REASON)).toBe(false);
	for (const page of [0, 1]) {
		const delivered = output(page, TELEGRAM_REFRESH_BUSY_REASON, undefined, payload(low));
		expect(Buffer.byteLength(`${JSON.stringify(delivered)}\n`)).toBeLessThanOrEqual(28_000);
		expect(Buffer.byteLength(`${checkpointText(delivered, true)}\n`)).toBeLessThanOrEqual(
			24_000,
		);
	}
});
