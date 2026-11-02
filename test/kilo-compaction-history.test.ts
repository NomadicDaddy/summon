import { afterEach, beforeEach, expect, test } from 'bun:test';

import { readCompactions } from '../src/compaction-history.ts';
import { initializeKiloTurn, kiloTurn } from '../src/kilo-turn-state.ts';
import { observeKiloStream } from '../src/kilo-turn-stream.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const oldHome = process.env.SUMMON_HOME;
const launch = { name: 'alpha', nonce: 'compaction-stream' };
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeKiloTurn('alpha', launch.nonce, 'ses_exact', 'owned-stream');
});
afterEach(async () => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	await fixture.dispose();
});

test('actual owned SSE consumer retains native IDs once and never treats compaction as idle', async () => {
	const events = [
		{ id: 'event-child', type: 'session.compacted', properties: { sessionID: 'ses_child' } },
		{
			id: 'event-one',
			type: 'session.compacted',
			properties: { sessionID: 'ses_exact', privateContext: 'PRIVATE_SENTINEL' },
		},
		{ id: 'event-one', type: 'session.compacted', properties: { sessionID: 'ses_exact' } },
	];
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
	expect(
		await observeKiloStream(
			new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
			new AbortController().signal,
			launch,
			'owned-stream',
		).catch((error: unknown) => String(error)),
	).toContain('closed');
	const history = await readCompactions('alpha', 10);
	expect(history.retainedObservations).toBe(1);
	expect(history.entries[0]?.record.nativeAt).toBeNull();
	expect(history.entries[0]?.record.phase).toBe('recorded');
	expect(JSON.stringify(history)).not.toContain('PRIVATE_SENTINEL');
	expect(JSON.stringify(history)).not.toContain('ses_exact');
	expect((await kiloTurn('alpha', launch.nonce))?.phase).toBe('unknown');
});

test('stale stream cannot retain an exact-session event after a new observer attaches', async () => {
	await initializeKiloTurn('alpha', launch.nonce, 'ses_exact', 'new-stream');
	const body = `data: ${JSON.stringify({ id: 'event-one', type: 'session.compacted', properties: { sessionID: 'ses_exact' } })}\n\n`;
	expect(
		await observeKiloStream(
			new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
			new AbortController().signal,
			launch,
			'owned-stream',
		).catch((error: unknown) => String(error)),
	).toContain('closed');
	expect((await readCompactions('alpha', 10)).retainedObservations).toBe(0);
	expect((await kiloTurn('alpha', launch.nonce))?.observer).toBe('new-stream');
});
