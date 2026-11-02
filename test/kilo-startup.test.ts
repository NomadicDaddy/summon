import { expect, test } from 'bun:test';

import { kiloStartup } from '../src/kilo-startup.ts';

test('startup waits for the exact authenticated session and submits only once', async () => {
	const startup = await kiloStartup('/work with spaces', 'ses_exact', 'local/model/variant');
	let reads = 0;
	const posts: unknown[] = [];
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: Number(startup.args.at(-1)),
		async fetch(request) {
			expect(request.headers.get('authorization')).toBe(
				`Basic ${Buffer.from(`kilo:${startup.env.KILO_SERVER_PASSWORD}`).toString('base64')}`,
			);
			const url = new URL(request.url);
			expect(url.searchParams.get('directory')).toBe('/work with spaces');
			if (request.method === 'GET') {
				expect(url.pathname).toBe('/session/ses_exact');
				return new Response(null, { status: ++reads === 1 ? 503 : 200 });
			}
			expect(url.pathname).toBe('/session/ses_exact/prompt_async');
			posts.push(await request.json());
			return new Response(null, { status: 204 });
		},
	});
	try {
		await startup.start(AbortSignal.timeout(2000));
		expect(reads).toBe(2);
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({
			model: { providerID: 'local', modelID: 'model/variant' },
		});
		expect(JSON.stringify(posts[0])).toContain('summon --checkpoint');
		expect(startup.env.KILO_NO_DAEMON).toBe('1');
	} finally {
		await server.stop(true);
	}
});

test('a rejected submission is never retried', async () => {
	const startup = await kiloStartup('/work', 'ses_exact');
	let posts = 0;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: Number(startup.args.at(-1)),
		fetch(request) {
			if (request.method === 'POST') posts++;
			return new Response(null, { status: request.method === 'POST' ? 503 : 200 });
		},
	});
	try {
		expect(await startup.start(AbortSignal.timeout(2000)).catch(String)).toContain(
			'acknowledge',
		);
		expect(posts).toBe(1);
	} finally {
		await server.stop(true);
	}
});

test('authentication failure and child exit cannot submit a startup turn', async () => {
	const startup = await kiloStartup('/work', 'ses_exact');
	let posts = 0;
	const abort = new AbortController();
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: Number(startup.args.at(-1)),
		fetch(request) {
			if (request.method === 'POST') posts++;
			abort.abort();
			return new Response(null, { status: 401 });
		},
	});
	try {
		expect(await startup.start(abort.signal).catch(String)).toContain('Abort');
		expect(posts).toBe(0);
	} finally {
		await server.stop(true);
	}
});
