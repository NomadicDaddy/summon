import { afterEach, beforeEach, expect, test } from 'bun:test';

import { kiloStartup } from '../src/kilo-startup.ts';
import { kiloNoticeAllowed, kiloTurn } from '../src/kilo-turn-state.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

// The real startup path against a fake owned worker: the receiver's gate (kiloNoticeAllowed) opens
// only after the startup POST settles and a busy then idle is observed (Phillip #22057).

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const oldHome = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	await fixture.dispose();
});

type Emit = (status: 'busy' | 'idle') => void;

/** Runs kiloStartup against a worker whose POST handler is `onPost`; returns its outcome. */
async function runStartup(
	nonce: string,
	onPost: (emit: Emit) => Promise<Response> | Response,
	afterStart?: (emit: Emit) => Promise<void>,
): Promise<{ error: unknown }> {
	const abort = new AbortController();
	const startup = await kiloStartup('/work', 'ses_exact', undefined, { name: 'alpha', nonce });
	let events: ReadableStreamDefaultController<Uint8Array> | undefined;
	const emit: Emit = (type) =>
		events?.enqueue(
			new TextEncoder().encode(
				`data: ${JSON.stringify({ type: 'session.status', properties: { sessionID: 'ses_exact', status: { type } } })}\n\n`,
			),
		);
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: Number(startup.args.at(-1)),
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === '/event')
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							events = controller;
							controller.enqueue(new TextEncoder().encode(': connected\n\n'));
						},
					}),
					{ headers: { 'content-type': 'text/event-stream' } },
				);
			if (request.method === 'GET') return new Response(null, { status: 200 });
			return onPost(emit);
		},
	});
	let error: unknown;
	try {
		await startup.start(abort.signal).catch((caught: unknown) => {
			error = caught;
		});
		await afterStart?.(emit);
		return { error };
	} finally {
		abort.abort();
		await server.stop(true);
	}
}

async function settledPhase(nonce: string, phase: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await kiloTurn('alpha', nonce))?.phase === phase) return;
		await Bun.sleep(10);
	}
}

test('accepted before the first busy: the gate opens only at the later observed idle', async () => {
	const nonce = 'consumer-accepted';
	const { error } = await runStartup(
		nonce,
		() => new Response(null, { status: 204 }),
		async (emit) => {
			expect((await kiloTurn('alpha', nonce))?.startup).toBe('accepted');
			expect(await kiloNoticeAllowed('alpha', nonce)).toBe(false);
			emit('busy');
			emit('idle');
			await settledPhase(nonce, 'idle');
			expect(await kiloNoticeAllowed('alpha', nonce)).toBe(true);
		},
	);
	expect(error).toBeUndefined();
});

test('a 500 is uncertain: nothing without events, open after a later busy then idle', async () => {
	const nonce = 'consumer-500';
	const { error } = await runStartup(
		nonce,
		() => new Response(null, { status: 500 }),
		async (emit) => {
			expect((await kiloTurn('alpha', nonce))?.startup).toBe('uncertain');
			expect(await kiloNoticeAllowed('alpha', nonce)).toBe(false);
			emit('busy');
			emit('idle');
			await settledPhase(nonce, 'idle');
			expect(await kiloNoticeAllowed('alpha', nonce)).toBe(true);
		},
	);
	expect(String(error)).toContain('did not acknowledge');
});

test('busy then idle inside a 500 response: uncertain, open at once', async () => {
	const nonce = 'consumer-500-latched';
	const { error } = await runStartup(nonce, async (emit) => {
		emit('busy');
		emit('idle');
		await settledPhase(nonce, 'idle');
		return new Response(null, { status: 500 });
	});
	expect(String(error)).toContain('did not acknowledge');
	expect((await kiloTurn('alpha', nonce))?.startup).toBe('uncertain');
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(true);
});

test('a POST that never answers times out as uncertain and sends nothing on its own', async () => {
	const nonce = 'consumer-timeout';
	const { error } = await runStartup(nonce, () => new Promise<Response>(() => {}));
	expect(error).toBeDefined();
	expect((await kiloTurn('alpha', nonce))?.startup).toBe('uncertain');
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(false);
}, 15000);
