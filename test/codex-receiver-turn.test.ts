import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { header, recordRead } from '../src/mail-read.ts';
import { markReady, runtimePath, saveDelivery } from '../src/mail-session.ts';
import { sendMessage } from '../src/mailbox.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

// Exercise the real binding -> watcher -> coordinator -> queue path. Only native I/O is replaced.
let phase: 'busy' | 'idle' | 'unknown' = 'busy';
let observations = 0;
await mock.module('../src/codex-turn-rpc.ts', () => ({
	readCodexThreadStatuses: (threads: readonly string[]) => {
		observations++;
		return Promise.resolve(new Map(threads.map((thread) => [thread, phase])));
	},
}));
await mock.module('../src/codex-compaction-history.ts', () => ({
	codexCompactionReader: () => () => Promise.resolve(true),
}));
const { waitForCodexBinding } = await import('../src/codex-mail-delivery.ts');
const realSpawn = Bun.spawn;
const saved = {
	SUMMON_HOME: process.env.SUMMON_HOME,
	SUMMON_AGENT: process.env.SUMMON_AGENT,
	SUMMON_NONCE: process.env.SUMMON_NONCE,
	PATH: process.env.PATH,
};
let fixture: Awaited<ReturnType<typeof mailHarness>>;
let stop: (() => Promise<void>) | undefined;
let launches: string[][] = [];
const nonce = 'test-launch';
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = nonce;
	const bin = join(fixture.root, 'bin');
	await mkdir(bin);
	await writeFile(join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex'), '', {
		mode: 0o700,
	});
	process.env.PATH = bin;
	await initializeActivity('alpha', nonce);
	await writeFile(join(runtimePath('alpha'), `${nonce}.binding`), 'fixture-thread');
	await saveDelivery('alpha', {
		nonce,
		pid: process.pid,
		state: 'unconfirmed',
		reason: '',
		thread: 'fixture-thread',
	});
	await markReady('alpha', nonce);
	phase = 'busy';
	observations = 0;
	launches = [];
	Bun.spawn = ((options: { cmd: string[] }) => {
		launches.push(options.cmd);
		return {
			exited: Promise.resolve(0),
			stderr: new ReadableStream({
				start(controller) {
					controller.close();
				},
			}),
		};
	}) as unknown as typeof Bun.spawn;
});
afterEach(async () => {
	await stop?.();
	stop = undefined;
	Bun.spawn = realSpawn;
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = value;
	}
	await fixture.dispose();
});
async function until(check: () => boolean): Promise<void> {
	const end = Date.now() + 5000;
	while (!check() && Date.now() < end) await Bun.sleep(20);
	expect(check()).toBe(true);
}

test('the production Codex receiver holds busy work, drops consumed bounds, and sends genuine later work', async () => {
	const id = await sendMessage('alpha', 'alpha', 'Consumed in the busy turn.');
	stop = waitForCodexBinding('alpha', nonce);
	await until(() => observations > 0 || launches.length > 0);
	expect(launches).toEqual([]);
	await recordRead('alpha', await header('alpha', id));
	phase = 'idle';
	await sendMessage('alpha', 'alpha', 'Genuinely later request.');
	await until(() => launches.length > 0);
	expect(launches).toHaveLength(1);
	expect(launches[0]?.slice(1, 5)).toEqual(['queue', '--thread', 'fixture-thread', '--message']);
	expect(launches[0]?.[5]).toContain('1 new mailbox event');
});
