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
	let initialCollected: () => void = () => {};
	const startup = new Promise<void>((resolve) => {
		initialCollected = resolve;
	});
	stop = await startMailWatcher(
		'alpha',
		'first-room',
		(text) => {
			sent.push(text);
			return Promise.resolve();
		},
		{
			noticeHold: () => {
				initialCollected();
				return Promise.resolve(undefined);
			},
		},
	);
	expect((await stat(room)).isDirectory()).toBe(true);
	await Promise.race([
		startup,
		Bun.sleep(5000).then(() => {
			throw new Error('Initial receiver collection did not complete.');
		}),
	]);
	// The initial collector has finished before this first-use file appears.
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
