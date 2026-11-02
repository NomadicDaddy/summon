import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
	initializeKiloTurn,
	kiloNoticeAllowed,
	kiloStartupSettled,
	kiloStartupSubmitting,
	kiloTurn,
} from '../src/kilo-turn-state.ts';
import { observeKiloStream, startKiloTurnStream } from '../src/kilo-turn-stream.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const oldHome = process.env.SUMMON_HOME;
const launch = { name: 'alpha', nonce: 'stream-kilo' };
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeKiloTurn('alpha', launch.nonce, 'ses_exact', 'stream-one');
	// The startup input is marked and accepted, so the stream's busy then idle completes it.
	await kiloStartupSubmitting('alpha', launch.nonce, 'ses_exact');
	await kiloStartupSettled('alpha', launch.nonce, 'ses_exact', 'accepted');
});
afterEach(async () => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	await fixture.dispose();
});
const encode = (type: string, sessionID = 'ses_exact'): Uint8Array =>
	new TextEncoder().encode(
		`data: ${JSON.stringify({ type: 'session.status', properties: { sessionID, status: { type } } })}\r\n\r\n`,
	);
async function phase(expected: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await kiloTurn('alpha', launch.nonce))?.phase === expected) return;
		await Bun.sleep(10);
	}
	throw new Error('Native fixture observation did not settle.');
}

test('fragmented CRLF stream is ordered and ignores child events; abort withdraws idle', async () => {
	let control: ReadableStreamDefaultController<Uint8Array> | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			control = controller;
		},
	});
	const abort = new AbortController();
	const task = observeKiloStream(
		new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
		abort.signal,
		launch,
		'stream-one',
	);
	const busy = encode('busy');
	control?.enqueue(busy.slice(0, 7));
	control?.enqueue(busy.slice(7));
	await phase('busy');
	control?.enqueue(encode('idle', 'child'));
	await Bun.sleep(20);
	expect(await kiloNoticeAllowed('alpha', launch.nonce)).toBe(false);
	control?.enqueue(encode('idle'));
	await phase('idle');
	expect(await kiloNoticeAllowed('alpha', launch.nonce)).toBe(true);
	abort.abort();
	await task;
	expect(await kiloNoticeAllowed('alpha', launch.nonce)).toBe(false);
});

test.each(['closed', 'malformed', 'oversized'] as const)(
	'stream %s fails closed without payload disclosure',
	async (kind) => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encode('busy'));
				controller.enqueue(encode('idle'));
				if (kind === 'malformed')
					controller.enqueue(new TextEncoder().encode('data: PRIVATE_SENTINEL\n\n'));
				if (kind === 'oversized')
					controller.enqueue(
						new TextEncoder().encode('data: ' + 'x'.repeat(1024 * 1024 + 1)),
					);
				controller.close();
			},
		});
		const error: unknown = await observeKiloStream(
			new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
			new AbortController().signal,
			launch,
			'stream-one',
		).catch((value: unknown) => value);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain('PRIVATE_SENTINEL');
		expect(await kiloNoticeAllowed('alpha', launch.nonce)).toBe(false);
	},
);

test('only an authenticated successful SSE response starts observations', async () => {
	let gets = 0;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			gets++;
			expect(request.headers.get('authorization')).toBe('Basic fixture-auth');
			return new Response('PRIVATE_RESPONSE', { status: 401 });
		},
	});
	try {
		const error: unknown = await startKiloTurnStream(
			new URL('event', server.url).href,
			{ Authorization: 'Basic fixture-auth' },
			AbortSignal.timeout(1000),
			launch,
			'ses_exact',
		).catch((value: unknown) => value);
		expect(String(error)).toContain('unavailable');
		expect(String(error)).not.toContain('PRIVATE_RESPONSE');
		expect(gets).toBe(1);
		expect(await kiloNoticeAllowed('alpha', launch.nonce)).toBe(false);
	} finally {
		await server.stop(true);
	}
});
