import { expect, test } from 'bun:test';

import { kiloStartup } from '../src/kilo-startup.ts';
import { kiloNoticeAllowed, kiloTurn } from '../src/kilo-turn-state.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

test('owned HTTP subscription precedes the single startup turn and closes with its child', async () => {
	const fixture = await mailHarness();
	const oldHome = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = fixture.records;
	const nonce = 'startup-stream';
	const abort = new AbortController();
	const startup = await kiloStartup('/work', 'ses_exact', undefined, { name: 'alpha', nonce });
	let subscribed = false;
	let posts = 0;
	let events: ReadableStreamDefaultController<Uint8Array> | undefined;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: Number(startup.args.at(-1)),
		fetch(request) {
			expect(request.headers.get('authorization')).toBe(
				`Basic ${Buffer.from(`kilo:${startup.env.KILO_SERVER_PASSWORD}`).toString('base64')}`,
			);
			const url = new URL(request.url);
			expect(url.searchParams.get('directory')).toBe('/work');
			if (url.pathname === '/event') {
				subscribed = true;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							events = controller;
							controller.enqueue(new TextEncoder().encode(': connected\n\n'));
						},
					}),
					{ headers: { 'content-type': 'text/event-stream' } },
				);
			}
			if (request.method === 'GET') return new Response(null, { status: 200 });
			expect(subscribed).toBe(true);
			posts++;
			for (const type of ['busy', 'idle'])
				events?.enqueue(
					new TextEncoder().encode(
						`data: ${JSON.stringify({ type: 'session.status', properties: { sessionID: 'ses_exact', status: { type } } })}\n\n`,
					),
				);
			return new Response(null, { status: 204 });
		},
	});
	try {
		await startup.start(abort.signal);
		for (
			let attempt = 0;
			attempt < 100 && (await kiloTurn('alpha', nonce))?.phase !== 'idle';
			attempt++
		)
			await Bun.sleep(10);
		expect((await kiloTurn('alpha', nonce))?.phase).toBe('idle');
		expect(posts).toBe(1);
		expect(await kiloNoticeAllowed('alpha', nonce)).toBe(true);
		abort.abort();
		for (
			let attempt = 0;
			attempt < 100 && (await kiloTurn('alpha', nonce))?.phase !== 'unknown';
			attempt++
		)
			await Bun.sleep(10);
		expect((await kiloTurn('alpha', nonce))?.phase).toBe('unknown');
	} finally {
		abort.abort();
		await server.stop(true);
		if (oldHome === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = oldHome;
		await fixture.dispose();
	}
});
