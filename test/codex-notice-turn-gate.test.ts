import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { optionalText } from '../src/mail-files.ts';
import { header, recordRead, statePath } from '../src/mail-read.ts';
import { deliveryStatus } from '../src/mail-session.ts';
import { sendMessage } from '../src/mailbox.ts';
import { readRest, restCommand } from '../src/rest.ts';
import {
	coalesceReceiver,
	operatorPost,
	readRoomThrough,
	releaseFixtureReceiver,
} from './fixtures/coalesce-receiver.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let phase: 'busy' | 'idle' | 'unknown' = 'idle';
let failed = false;
let observations = 0;
await mock.module('../src/codex-turn-rpc.ts', () => ({
	readCodexThreadStatuses: (threads: readonly string[]) => {
		observations++;
		if (failed) return Promise.reject(new Error('fixture status unavailable'));
		return Promise.resolve(new Map(threads.map((thread) => [thread, phase])));
	},
}));
const { codexNoticeGate } = await import('../src/codex-notice-gate.ts');
let fixture: Awaited<ReturnType<typeof mailHarness>>;
const nonce = 'test-launch';
const saved = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
};
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = nonce;
	phase = 'idle';
	failed = false;
	observations = 0;
});
afterEach(async () => {
	await releaseFixtureReceiver();
	for (const [key, value] of Object.entries({
		SUMMON_HOME: saved.home,
		SUMMON_AGENT: saved.agent,
		SUMMON_NONCE: saved.nonce,
	})) {
		if (value === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = value;
	}
	await fixture.dispose();
});
async function receiver() {
	const result = await coalesceReceiver(nonce, {
		coalesceQueuedNotices: true,
		...codexNoticeGate('alpha', nonce),
	});
	await writeFile(join(fixture.records, `runtime/alpha/${nonce}.binding`), 'fixture-thread');
	return result;
}
const request = (text: string) => sendMessage('alpha', 'alpha', text);
const read = async (id: string) => recordRead('alpha', await header('alpha', id));

test('empty receiver cycles do not poll the native daemon', async () => {
	const { cycle, sent } = await receiver();
	phase = 'busy';
	await cycle();
	await cycle();
	expect(observations).toBe(0);
	expect(sent).toEqual([]);
});

test('consumed work clears stale busy status without polling an empty cycle', async () => {
	const { cycle, sent } = await receiver();
	phase = 'busy';
	const id = await request('Consumed by the active turn before another notice is needed.');
	await cycle();
	expect((await deliveryStatus('alpha', nonce)).reason).toContain('Codex native busy');
	await read(id);
	const beforeEmpty = observations;
	phase = 'idle';
	await cycle();
	expect(observations).toBe(beforeEmpty);
	expect(sent).toEqual([]);
	expect((await deliveryStatus('alpha', nonce)).reason).not.toContain('Codex native busy');
	phase = 'busy';
	await request('Fresh work must still observe and respect a busy native turn.');
	await cycle();
	expect(observations).toBeGreaterThan(beforeEmpty);
	expect(sent).toEqual([]);
	expect((await deliveryStatus('alpha', nonce)).reason).toContain('Codex native busy');
});

test('native busy retains unread work without queue input', async () => {
	const { cycle, sent } = await receiver();
	phase = 'busy';
	const id = await request('Real unread work.');
	await cycle();
	expect(sent).toEqual([]);
	expect(await optionalText(statePath('alpha', id, 'read'))).toBeUndefined();
	expect((await deliveryStatus('alpha', nonce)).reason).toContain('Codex native busy');
	phase = 'idle';
	await cycle();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain('1 new mailbox event');
});

// Where no Codex app-server daemon runs, every read is unknown; holding on it left seats deaf.
test('native unknown delivers as before the busy-turn hold, without claiming a hold', async () => {
	const { cycle, sent } = await receiver();
	phase = 'unknown';
	await request('Work for a seat whose turn cannot be observed.');
	await cycle();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain('1 new mailbox event');
	expect((await deliveryStatus('alpha', nonce)).reason).not.toContain('Notices held');
});

test('a failed native read is unknown: it delivers and is never reported as idle or held', async () => {
	const { cycle, sent } = await receiver();
	failed = true;
	await request('Deliver this request.');
	await cycle();
	expect(sent).toHaveLength(1);
	const { reason } = await deliveryStatus('alpha', nonce);
	expect(reason).not.toContain('Notices held');
	expect(reason).not.toContain('idle');
});

test('busy then unknown releases the held notice; unknown then busy holds the next', async () => {
	const { cycle, sent } = await receiver();
	phase = 'busy';
	const first = await request('Held while busy.');
	await cycle();
	expect(sent).toEqual([]);
	expect((await deliveryStatus('alpha', nonce)).reason).toContain(
		'Notices held for Codex native busy.',
	);
	phase = 'unknown';
	await cycle();
	expect(sent).toHaveLength(1);
	// The hold the busy turn set is cleared once the notice goes out, not left as stale status.
	expect((await deliveryStatus('alpha', nonce)).reason).not.toContain('Notices held');
	await read(first);
	phase = 'busy';
	await request('Arrives during a busy turn.');
	await cycle();
	expect(sent).toHaveLength(1);
	expect((await deliveryStatus('alpha', nonce)).reason).toContain('Codex native busy');
});

test('native unknown keeps queued-notice coalescing', async () => {
	const { cycle, sent } = await receiver();
	phase = 'unknown';
	const first = await request('First, queued and not yet read.');
	await cycle();
	expect(sent).toHaveLength(1);
	await request('Second, while the first is still queued.');
	await cycle();
	expect(sent).toHaveLength(1);
	await read(first);
	await cycle();
	expect(sent).toHaveLength(2);
});

test('explicit hibernation control retains its separate path while native busy', async () => {
	const { cycle, sent } = await receiver();
	phase = 'busy';
	await request('Pending ordinary work remains unread.');
	expect((await fixture.run(['--hibernate', 'alpha'])).code).toBe(0);
	await cycle();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain('hibernated');
	expect(observations).toBe(0);
});

test('reading mail during a busy turn cannot release another queued notice', async () => {
	const { cycle, sent } = await receiver();
	const first = await request('First request.');
	await cycle();
	expect(sent).toHaveLength(1);
	phase = 'busy';
	await read(first);
	const later = await request('Later request consumed in this same turn.');
	await cycle();
	expect(sent).toHaveLength(1);
	await read(later);
	await restCommand(['ready']);
	expect((await readRest('alpha'))?.mode).toBe('ready');
	phase = 'idle';
	await cycle();
	expect(sent).toHaveLength(1);
	expect((await readRest('alpha'))?.mode).toBe('ready');
	await request('Genuinely later work after confirmed rest.');
	await cycle();
	expect(sent).toHaveLength(2);
	expect(sent[1]).toContain('1 new mailbox event');
});

test('Room read coverage during a busy turn does not queue a second Room batch', async () => {
	const { cycle, sent } = await receiver();
	const first = await operatorPost('First operator post.');
	await cycle();
	expect(sent).toHaveLength(1);
	phase = 'busy';
	await readRoomThrough(first.id);
	const later = await operatorPost('Later operator post read by the active turn.');
	await cycle();
	expect(sent).toHaveLength(1);
	await readRoomThrough(later.id);
	phase = 'idle';
	await cycle();
	expect(sent).toHaveLength(1);
	const fresh = await operatorPost('Fresh operator work remains wakeable.');
	await cycle();
	expect(sent).toHaveLength(2);
	expect(sent[1]).toContain(`through ${fresh.id}`);
});
