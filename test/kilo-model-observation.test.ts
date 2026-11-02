import { expect, test } from 'bun:test';

import { initializeActivity } from '../src/agent-activity.ts';
import { captureKiloModel, readKiloCapacity } from '../src/kilo-model-observation.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

test('Kilo capacity uses the exact owned model and rejects changed snapshots and launch identity', async () => {
	const fixture = await mailHarness();
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = fixture.records;
	const launch = { name: 'alpha', nonce: 'capacity-launch' };
	await initializeActivity(launch.name, launch.nonce, 'kilo');
	let capacity = 262144;
	let reads = 0;
	let change = false;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: (request) => {
			if (request.headers.get('authorization') !== 'fixture-key')
				return new Response(null, { status: 403 });
			const url = new URL(request.url);
			if (url.pathname === '/provider')
				return Response.json({
					all: [
						{
							id: 'native',
							models: {
								'model-a': { limit: { context: capacity }, unrelated: 'PRIVATE' },
							},
						},
					],
				});
			reads++;
			return Response.json({
				id: 'exact-session',
				model: { providerID: 'native', id: change && reads > 1 ? 'model-b' : 'model-a' },
				time: { updated: 1 },
			});
		},
	});
	const capture = () =>
		captureKiloModel(
			server.url.origin,
			'?directory=fixture',
			{ Authorization: 'fixture-key' },
			new AbortController().signal,
			launch,
			'exact-session',
		);
	try {
		await capture();
		expect(await readKiloCapacity('alpha', 'exact-session', 'native/model-a')).toBe(262144);
		expect(await readKiloCapacity('alpha', 'other', 'native/model-a')).toBeUndefined();
		expect(await readKiloCapacity('alpha', 'exact-session', 'native/model-b')).toBeUndefined();
		capacity = 1000000;
		change = true;
		reads = 0;
		await capture();
		expect(await readKiloCapacity('alpha', 'exact-session', 'native/model-a')).toBe(262144);
		change = false;
		capacity = 0;
		await capture();
		expect(await readKiloCapacity('alpha', 'exact-session', 'native/model-a')).toBeUndefined();
		await initializeActivity('alpha', 'replacement', 'kilo');
		capacity = 1000000;
		await capture();
		expect(await readKiloCapacity('alpha', 'exact-session', 'native/model-a')).toBeUndefined();
	} finally {
		await server.stop(true);
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await fixture.dispose();
	}
});
