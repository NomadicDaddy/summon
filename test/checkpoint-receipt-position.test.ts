import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { checkpointHash } from '../src/checkpoint-package-model.ts';
import { sendMessage } from '../src/mailbox.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

interface Batch {
	receipt: string;
	package: { id: string; phase: string; page: number };
}

test('manifest identifies the pending receipt after a refusal without advancing coverage', async () => {
	const h = await mailHarness();
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = h.records;
	try {
		// Force two pages by byte pressure, independent of an item-count ceiling.
		for (let index = 0; index < 6; index++)
			expect(
				(await h.run(['--room', 'send', `message ${index}: ${'x'.repeat(3900)}`], 'beta'))
					.code,
			).toBe(0);
		const mail = await sendMessage('beta', 'alpha', 'Unread coverage positive control');
		const readMarker = Bun.file(join(h.records, 'mailboxes/alpha/delivery', `${mail}.read`));
		const first = JSON.parse((await h.run(['--checkpoint'], 'alpha')).out) as Batch;
		const second = JSON.parse(
			(await h.run(['--checkpoint', first.receipt], 'alpha')).out,
		) as Batch;
		expect(second.package.page).toBe(2);
		expect(second.package.phase).toBe('page');
		const before = await h.read('runtime/alpha/checkpoint.json');
		const packet = await h.read('runtime/alpha/checkpoint-package.json');
		const bad = await h.run(['--checkpoint', '11111111-1111-4111-8111-111111111111'], 'alpha');
		expect(bad.error).toContain('Unknown checkpoint receipt');
		const manifestOutput = (await h.run(['--checkpoint', 'manifest'], 'alpha')).out;
		expect(manifestOutput).not.toContain(second.receipt);
		const manifest = JSON.parse(manifestOutput) as {
			id: string;
			position: { phase: string; page: number; receiptSha256: string };
		};
		expect(manifest.id).toBe(second.package.id);
		expect(manifest.position).toEqual({
			phase: 'page',
			page: 2,
			receiptSha256: checkpointHash(second.receipt),
		});
		const hashRefusal = await h.run(['--checkpoint', manifest.position.receiptSha256], 'alpha');
		expect(hashRefusal.code).toBe(1);
		expect(hashRefusal.error).toContain('Invalid checkpoint receipt');
		expect(await h.read('runtime/alpha/checkpoint.json')).toBe(before);
		expect(await h.read('runtime/alpha/checkpoint-package.json')).toBe(packet);
		expect(await readMarker.exists()).toBe(false);
		const replay = JSON.parse((await h.run(['--checkpoint'], 'alpha')).out) as Batch;
		expect(checkpointHash(replay.receipt)).toBe(manifest.position.receiptSha256);
		const final = JSON.parse(
			(await h.run(['--checkpoint', replay.receipt], 'alpha')).out,
		) as Batch;
		expect(final.package.phase).toBe('final');
		expect(await readMarker.exists()).toBe(true);
		const finalOutput = (await h.run(['--checkpoint', 'manifest'], 'alpha')).out;
		expect(finalOutput).not.toContain(final.receipt);
		const finalIndex = JSON.parse(finalOutput) as {
			position: { phase: string; page: number; receiptSha256: string };
		};
		expect(finalIndex.position).toEqual({
			phase: 'final',
			page: 2,
			receiptSha256: checkpointHash(final.receipt),
		});
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await h.dispose();
	}
}, 15_000);
