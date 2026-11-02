import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { CheckpointPackage, CheckpointState } from '../src/checkpoint-package-model.ts';

import { parseCheckpointPackage } from '../src/checkpoint-package-model.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let packet: CheckpointPackage;
await mock.module('../src/checkpoint-package-capture.ts', () => ({
	captureCheckpoint: () => Promise.resolve(packet),
}));
const { newCheckpointPackage } = await import('../src/checkpoint-package-store.ts');
let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

for (const acknowledged of [false, true])
	test(`publication schema drift preserves evidence and reports acknowledgment=${acknowledged}`, async () => {
		const retained = JSON.parse(
			await Bun.file(
				new URL('./fixtures/checkpoint-notice-458aaf1.fixture', import.meta.url),
			).text(),
		) as { packet: string };
		packet = parseCheckpointPackage(retained.packet);
		const header = packet.pages[0]?.completeMail[0];
		if (!header) throw new Error('Missing fixture notice');
		Object.assign(header, { unexpected: 'schema drift' });
		const state: CheckpointState = {
			version: 2,
			seenHolds: {},
			...(acknowledged ? { lastAck: randomUUID() } : {}),
		};
		const statePath = join(fixture.records, 'runtime/alpha/checkpoint.json');
		const packetPath = join(fixture.records, 'runtime/alpha/checkpoint-package.json');
		const before = JSON.stringify(state);
		await Bun.write(statePath, before);
		await Bun.write(packetPath, retained.packet);
		expect(await newCheckpointPackage('alpha', state).catch(String)).toBe(
			`Error: Next checkpoint package failed validation before publication. Last acknowledged receipt: ${state.lastAck ?? 'none'}. No new package was saved.`,
		);
		expect(await Bun.file(packetPath).text()).toBe(retained.packet);
		expect(await Bun.file(statePath).text()).toBe(before);
		expect(JSON.stringify(state)).toBe(before);
	});
