import { expect, test } from 'bun:test';

import { kiloStartup } from '../src/kilo-startup.ts';
import { storedKiloVariant, validKiloVariant } from '../src/kilo-variant.ts';

interface Fake {
	session?: unknown;
	providers?: unknown;
	providerStatus?: number;
	/** Per-read catalog answers, for a Kilo still loading; the last one repeats. */
	catalog?: { status?: number; body?: unknown }[];
	/** The catalog never answers, as a stalled Kilo would not. */
	stall?: boolean;
}

/** A fake owned Kilo worker: records every POST body and every /provider read. */
async function run(model: string | undefined, fake: Fake, registered?: string, waitMs = 1200) {
	const startup = await kiloStartup('/work', 'ses_exact', model, undefined, registered, waitMs);
	const posts: Record<string, unknown>[] = [];
	let providerReads = 0;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: Number(startup.args.at(-1)),
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method === 'POST') {
				posts.push((await request.json()) as Record<string, unknown>);
				return new Response(null, { status: 204 });
			}
			if (url.pathname === '/provider') {
				providerReads++;
				if (fake.stall) return new Promise<Response>(() => {});
				const step = fake.catalog?.[Math.min(providerReads, fake.catalog.length) - 1];
				return Response.json(step?.body ?? fake.providers ?? { all: [] }, {
					status: step?.status ?? fake.providerStatus ?? 200,
				});
			}
			return fake.session === undefined
				? new Response(null, { status: 200 })
				: Response.json(fake.session);
		},
	});
	try {
		await startup.start(AbortSignal.timeout(3000));
	} finally {
		await server.stop(true);
	}
	return { posts, providerReads };
}

const session = (variant?: string, id = 'ses_exact') => ({
	id,
	model: { id: 'glm-5.3', providerID: 'zai', ...(variant ? { variant } : {}) },
});
const providers = (variants: Record<string, unknown> | undefined) => ({
	all: [{ id: 'zai', models: { 'glm-5.3': variants ? { variants } : {} } }],
});

test('a stored variant the selected model supports is carried into the startup turn', async () => {
	const { posts, providerReads } = await run('zai/glm-5.3', {
		session: session('high'),
		providers: providers({ high: {}, low: {} }),
	});
	expect(providerReads).toBe(1);
	expect(posts).toHaveLength(1);
	expect(posts[0]).toMatchObject({
		model: { providerID: 'zai', modelID: 'glm-5.3' },
		variant: 'high',
	});
});

test('a medium choice is preserved as medium, never raised to high', async () => {
	const { posts } = await run('zai/glm-5.3', {
		session: session('medium'),
		providers: providers({ high: {}, medium: {} }),
	});
	expect(posts[0]?.variant).toBe('medium');
});

test('a variant the selected model does not list is not sent', async () => {
	const { posts } = await run('zai/glm-5.3', {
		session: session('high'),
		providers: providers({ low: {} }),
	});
	expect(posts).toHaveLength(1);
	expect(posts[0]).not.toHaveProperty('variant');
});

test('a model without variants gets none', async () => {
	const { posts } = await run('zai/glm-5.3', {
		session: session('high'),
		providers: providers(undefined),
	});
	expect(posts[0]).not.toHaveProperty('variant');
});

test('a stored default or absent variant sends none and skips the catalog read', async () => {
	for (const variant of ['default', undefined]) {
		const { posts, providerReads } = await run('zai/glm-5.3', { session: session(variant) });
		expect(providerReads).toBe(0);
		expect(posts[0]).not.toHaveProperty('variant');
	}
});

test('without a configured model Kilo keeps its own variant: nothing extra is sent', async () => {
	const { posts, providerReads } = await run(undefined, { session: session('high') });
	expect(providerReads).toBe(0);
	expect(posts).toHaveLength(1);
	expect(posts[0]).not.toHaveProperty('model');
	expect(posts[0]).not.toHaveProperty('variant');
});

/** Runs a startup and returns its result plus every line it logged to stderr. */
async function logged(...args: Parameters<typeof run>) {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...parts: unknown[]) => lines.push(parts.join(' '));
	try {
		return { ...(await run(...args)), lines };
	} finally {
		console.error = original;
	}
}

test('a catalog that never answers cannot stretch the wait past its budget', async () => {
	const started = Date.now();
	const { posts, lines } = await logged('zai/glm-5.3', { session: session('high'), stall: true });
	// A 1.2 s budget with up-to-3 s reads used to run to about 3 s here; each read is now capped.
	expect(Date.now() - started).toBeLessThan(2000);
	expect(posts).toHaveLength(1);
	expect(posts[0]).not.toHaveProperty('variant');
	expect(lines).toEqual([
		'Kilo reasoning variant high not sent: catalog read failed or timed out.',
	]);
});

test('a catalog that keeps failing is retried until the wait, then submits once without a variant and says why', async () => {
	const { posts, providerReads, lines } = await logged('zai/glm-5.3', {
		session: session('high'),
		providerStatus: 500,
	});
	expect(providerReads).toBeGreaterThan(1);
	expect(posts).toHaveLength(1);
	expect(posts[0]).not.toHaveProperty('variant');
	expect(lines).toEqual(['Kilo reasoning variant high not sent: catalog answered 500.']);
});

test('a Kilo still loading its catalog gets the variant once the catalog is ready', async () => {
	const { posts, providerReads, lines } = await logged(
		'zai/glm-5.3',
		{
			session: session(),
			catalog: [
				{ status: 503 },
				{ body: { all: [] } },
				{ body: providers({ high: {}, low: {} }) },
			],
		},
		'high',
		5000,
	);
	expect(providerReads).toBe(3);
	expect(posts).toHaveLength(1);
	expect(posts[0]?.variant).toBe('high');
	expect(lines).toEqual([]);
});

test('a settled refusal is not retried and is logged', async () => {
	const unlisted = await logged('zai/glm-5.3', {
		session: session('high'),
		providers: providers({ low: {} }),
	});
	expect(unlisted.providerReads).toBe(1);
	expect(unlisted.lines).toEqual([
		'Kilo reasoning variant high not sent: the model does not list it.',
	]);
	const twice = await logged('zai/glm-5.3', {
		session: session('high'),
		providers: {
			all: [
				{ id: 'zai', models: { 'glm-5.3': { variants: { high: {} } } } },
				{ id: 'zai', models: { 'glm-5.3': { variants: { high: {} } } } },
			],
		},
	});
	expect(twice.providerReads).toBe(1);
	expect(twice.posts[0]).not.toHaveProperty('variant');
	expect(twice.lines).toEqual([
		'Kilo reasoning variant high not sent: catalog lists provider zai twice.',
	]);
});

test('a fresh or cleared session takes the seat registered variant when the model lists it', async () => {
	for (const variant of ['default', undefined]) {
		const { posts, providerReads } = await run(
			'zai/glm-5.3',
			{ session: session(variant), providers: providers({ high: {}, low: {} }) },
			'high',
		);
		expect(providerReads).toBe(1);
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({
			model: { providerID: 'zai', modelID: 'glm-5.3' },
			variant: 'high',
		});
	}
});

test('the registered variant is the seat setting; a stored one counts only without it', async () => {
	// Phillip #20221 A: the agent config rewrites the stored variant on every turn, so a stored
	// value is no longer the session's own choice and must not override the registration.
	const registered = await run(
		'zai/glm-5.3',
		{ session: session('medium'), providers: providers({ high: {}, medium: {} }) },
		'high',
	);
	expect(registered.posts[0]?.variant).toBe('high');
	const unregistered = await run('zai/glm-5.3', {
		session: session('medium'),
		providers: providers({ high: {}, medium: {} }),
	});
	expect(unregistered.posts[0]?.variant).toBe('medium');
});

test('a registered variant the model does not list, or one without a model, is not sent', async () => {
	const unlisted = await run(
		'zai/glm-5.3',
		{ session: session(), providers: providers({ low: {} }) },
		'high',
	);
	expect(unlisted.posts[0]).not.toHaveProperty('variant');
	const modelless = await run(undefined, { session: session() }, 'high');
	expect(modelless.providerReads).toBe(0);
	expect(modelless.posts[0]).not.toHaveProperty('variant');
});

test('a registered variant needs Kilo, a model and a real name; "default" is no setting', () => {
	expect(validKiloVariant('kilo', 'zai/glm-5.3', undefined)).toBe(true);
	expect(validKiloVariant('claude', undefined, undefined)).toBe(true);
	expect(validKiloVariant('kilo', 'zai/glm-5.3', 'high')).toBe(true);
	expect(validKiloVariant('codex', 'zai/glm-5.3', 'high')).toBe(false);
	expect(validKiloVariant('kilo', undefined, 'high')).toBe(false);
	expect(validKiloVariant('kilo', 'zai/glm-5.3', 'default')).toBe(false);
	expect(validKiloVariant('kilo', 'zai/glm-5.3', 'hi gh')).toBe(false);
	expect(validKiloVariant('kilo', 'zai/glm-5.3', 7)).toBe(false);
});

test('only the exact session and a plain variant name count as a stored choice', () => {
	expect(storedKiloVariant(session('high'), 'ses_exact')).toBe('high');
	expect(storedKiloVariant(session('high', 'ses_other'), 'ses_exact')).toBeUndefined();
	expect(storedKiloVariant(session('default'), 'ses_exact')).toBeUndefined();
	expect(storedKiloVariant(session('hi gh'), 'ses_exact')).toBeUndefined();
	expect(storedKiloVariant(undefined, 'ses_exact')).toBeUndefined();
	expect(storedKiloVariant({ id: 'ses_exact', model: 'zai/glm' }, 'ses_exact')).toBeUndefined();
});
