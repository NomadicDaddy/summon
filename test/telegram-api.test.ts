import { expect, spyOn, test } from 'bun:test';

import { telegramRequest, TelegramRequestError } from '../src/telegram-api.ts';

const config = { botToken: '123:fixture', chatId: '456', allowedUserIds: ['456'] };

test.each([
	['ENOTFOUND', 'Telegram DNS lookup failed.'],
	['ECONNRESET', 'The connection to Telegram was reset.'],
	['TimeoutError', 'The Telegram request timed out.'],
	['UNKNOWN', 'The Telegram network request failed.'],
])(
	'Telegram retains a safe network reason for %s without the request URL',
	async (kind, reason) => {
		const error = Object.assign(
			new Error('PRIVATE_CANARY_URL'),
			kind === 'TimeoutError' ? { name: kind } : { code: kind },
		);
		const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(error);
		try {
			const result: unknown = await telegramRequest(config, 'getUpdates', {}).catch(
				(value: unknown) => value,
			);
			expect(result).toBeInstanceOf(TelegramRequestError);
			if (!(result instanceof TelegramRequestError))
				throw new Error('Expected safe request error');
			expect(result.reason).toBe(reason);
			expect(result.message).not.toContain('PRIVATE_CANARY');
			expect(result.cause).toBeUndefined();
		} finally {
			fetch.mockRestore();
		}
	},
);

test('invalid Telegram JSON is distinguished without copying response contents', async () => {
	const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{PRIVATE_CANARY'));
	try {
		const result: unknown = await telegramRequest(config, 'getUpdates', {}).catch(
			(value: unknown) => value,
		);
		expect(result).toBeInstanceOf(TelegramRequestError);
		if (!(result instanceof TelegramRequestError))
			throw new Error('Expected safe request error');
		expect(result.reason).toBe('Telegram returned invalid JSON.');
		expect(result.message).not.toContain('PRIVATE_CANARY');
	} finally {
		fetch.mockRestore();
	}
});

test.each([true, false])(
	'Telegram caps and cancels oversized bodies (declared=%s)',
	async (declared) => {
		let cancelled = false;
		let chunks = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				chunks++;
				controller.enqueue(new Uint8Array(1024 * 1024));
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = new Response(stream, {
			headers: declared ? { 'Content-Length': String(8 * 1024 * 1024) } : {},
		});
		const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(response);
		try {
			const result: unknown = await telegramRequest(config, 'getUpdates', {}).catch(
				(error: unknown) => error,
			);
			expect(result).toBeInstanceOf(Error);
			expect((result as Error).message).toBe(
				'Telegram request could not be confirmed. The Telegram response exceeded the 4 MiB safety limit. Check the chat before retrying a send.',
			);
			expect(cancelled).toBe(true);
			expect(chunks).toBeLessThanOrEqual(declared ? 1 : 6);
		} finally {
			fetch.mockRestore();
		}
	},
);

test('Telegram preserves split UTF-8 response text under the limit', async () => {
	const bytes = new TextEncoder().encode(JSON.stringify({ ok: true, result: 'hello 🌍' }));
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
				controller.close();
			},
		}),
	);
	const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(response);
	try {
		expect(await telegramRequest(config, 'getUpdates', {})).toBe('hello 🌍');
	} finally {
		fetch.mockRestore();
	}
});
