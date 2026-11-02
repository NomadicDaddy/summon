import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { startClaudeTurnBridge } from '../src/claude-turn-bridge.ts';
import { claudeNoticeAllowed, claudeTurn } from '../src/claude-turn-state.ts';
import { markReady, saveDelivery } from '../src/mail-session.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let bridge: Awaited<ReturnType<typeof startClaudeTurnBridge>>;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'bridge-claude';
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_NONCE = nonce;
	await saveDelivery('alpha', {
		nonce,
		thread: 'exact',
		pid: process.pid,
		state: 'unconfirmed',
		reason: '',
	});
	bridge = await startClaudeTurnBridge('alpha', nonce, 'exact');
	await markReady('alpha', nonce);
});
afterEach(async () => {
	await bridge.stop();
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = oldNonce;
	await fixture.dispose();
});
function send(sequence: number, kind: string, turn: string | null = null, extra = {}) {
	return fetch(bridge.env.SUMMON_CLAUDE_TURN_URL, {
		method: 'POST',
		headers: { authorization: `Bearer ${bridge.env.SUMMON_CLAUDE_TURN_KEY}` },
		body: JSON.stringify({
			session: 'exact',
			epoch: 1,
			sequence,
			kind,
			turn,
			completed: kind === 'complete',
			draft: false,
			...extra,
		}),
	});
}
test('authenticated own metadata drives the gate; wrong bearer changes nothing', async () => {
	const before = await claudeTurn('alpha', nonce);
	const wrong = await fetch(bridge.env.SUMMON_CLAUDE_TURN_URL, {
		method: 'POST',
		headers: { authorization: 'Bearer fixture-wrong-token' },
		body: '{}',
	});
	expect(wrong.status).toBe(403);
	expect(await claudeTurn('alpha', nonce)).toEqual(before);
	expect((await send(1, 'attach')).status).toBe(204);
	expect((await send(2, 'start', 'one')).status).toBe(204);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	expect((await send(3, 'complete', 'one')).status).toBe(204);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
	const directory = bridge.args[1];
	if (!directory) throw new Error('Missing generated plugin directory');
	for (const path of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.js']) {
		const text = await Bun.file(join(directory, path)).text();
		expect(text).not.toContain(bridge.env.SUMMON_CLAUDE_TURN_KEY);
		expect(text).not.toContain('PRIVATE');
	}
});
test('wrong thread or private extra fields invalidate observation; bridge close invalidates idle', async () => {
	await send(1, 'attach');
	await send(2, 'start', 'one');
	await send(3, 'complete', 'one');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
	expect((await send(4, 'draft', null, { answer: 'PRIVATE_SENTINEL' })).status).toBe(400);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	expect(JSON.stringify(await claudeTurn('alpha', nonce))).not.toContain('PRIVATE');
	expect((await send(4, 'draft', null, { session: 'peer' })).status).toBe(400);
	await bridge.stop();
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
});
