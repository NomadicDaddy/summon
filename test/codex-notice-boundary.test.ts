import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { queueCodex } from '../src/codex-mail-delivery.ts';
import { applyTelegramSignal } from '../src/communication-state.ts';
import { atomicWrite, optionalText } from '../src/mail-files.ts';
import { prepareMailNotice } from '../src/mail-notice.ts';
import { header, recordRead, statePath } from '../src/mail-read.ts';
import { sendMessage } from '../src/mailbox.ts';
import { NotificationNotSentError } from '../src/notification-delivery.ts';
import { teamWindowRuntime } from '../src/team-startup.ts';
import { wakeDeliveryStatus } from '../src/wake-delivery-store.ts';
import { deliverWakeParts } from '../src/wake-delivery.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

const saved = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
	path: process.env.PATH,
};
const realSpawn = Bun.spawn;
let fixture: Awaited<ReturnType<typeof mailHarness>>;
let launches = 0;
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
	launches = 0;
	Bun.spawn = (() => {
		launches++;
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
	Bun.spawn = realSpawn;
	for (const [key, value] of Object.entries({
		SUMMON_HOME: saved.home,
		SUMMON_AGENT: saved.agent,
		SUMMON_NONCE: saved.nonce,
		PATH: saved.path,
	})) {
		if (value === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = value;
	}
	await fixture.dispose();
});

test.each(['read', 'halt', 'ordinary hold'] as const)(
	'a late %s prevents native queue input and retains an honest outcome',
	async (change) => {
		const id = await sendMessage('alpha', 'alpha', 'Real pending source.');
		const part = await prepareMailNotice('alpha', nonce);
		if (!part) throw new Error('Missing source positive control.');
		const result: unknown = await deliverWakeParts(
			'alpha',
			nonce,
			[part],
			async (text, revalidate) => {
				if (change === 'read') await recordRead('alpha', await header('alpha', id));
				if (change === 'ordinary hold')
					await atomicWrite(
						teamWindowRuntime('operator-view.json'),
						JSON.stringify({
							name: 'alpha',
							pid: process.pid,
							expires: Date.now() + 5000,
						}),
					);
				await queueCodex('fixture-thread', text, 3000, async () => {
					const valid = await revalidate?.();
					// Halt arrives while the asynchronous validator is still in flight.
					if (change === 'halt')
						await applyTelegramSignal(
							'fixture-bot',
							1,
							Date.now() / 1000,
							'halt',
							'123',
						);
					return valid ?? false;
				});
			},
			() => Promise.resolve(true),
		).catch((error: unknown) => error);
		expect(result).toBeInstanceOf(NotificationNotSentError);
		expect(launches).toBe(0);
		expect((await wakeDeliveryStatus('alpha', nonce)).latest?.state).toBe('not-sent');
		const readMarker = await optionalText(statePath('alpha', id, 'read'));
		if (change === 'read') expect(readMarker).toBeDefined();
		else expect(readMarker).toBeUndefined();
	},
);
