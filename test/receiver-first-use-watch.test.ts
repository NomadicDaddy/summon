import { afterEach, beforeEach, expect, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { appendLocalEvent } from '../src/local-room.ts';
import { startMailWatcher } from '../src/mail-watcher.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let stop: (() => Promise<void>) | undefined;
const previousHome = process.env.SUMMON_HOME;

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	await stop?.();
	stop = undefined;
	if (previousHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousHome;
	await fixture.dispose();
});

test('a first Room post wakes through its new directory without waiting for fallback', async () => {
	const room = join(fixture.records, 'room');
	expect(await Bun.file(join(room, 'events.json')).exists()).toBe(false);
	const sent: string[] = [];
	stop = await startMailWatcher('alpha', 'first-room', (text) => {
		sent.push(text);
		return Promise.resolve();
	});
	expect((await stat(room)).isDirectory()).toBe(true);
	// Let startup settle so its initial scan cannot deliver the post without a file watch.
	await Bun.sleep(1500);
	const postedAt = Date.now();
	await appendLocalEvent({
		sender: { kind: 'user', id: 'operator' },
		text: '@alpha first post',
		replyTo: null,
		source: 'local',
	});
	for (let attempt = 0; attempt < 100; attempt++) {
		if (sent.some((text) => text.includes('summon room through 1'))) return;
		await Bun.sleep(20);
	}
	throw new Error(`First Room post missed its native wake within ${Date.now() - postedAt} ms.`);
}, 20000);
