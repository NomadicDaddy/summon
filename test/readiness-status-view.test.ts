import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { awaitingReadinessReason } from '../src/mail-session.ts';
import { processAlive } from '../src/process-owner.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let runtime: string;
beforeEach(async () => {
	fixture = await mailHarness();
	runtime = join(fixture.records, 'runtime', 'alpha');
	await mkdir(runtime, { recursive: true });
});
afterEach(async () => {
	await fixture.dispose();
});

async function save(state = 'unconfirmed', reason = awaitingReadinessReason, pid = process.pid) {
	await writeFile(
		join(runtime, 'test-launch.json'),
		JSON.stringify({
			nonce: 'test-launch',
			pid,
			state,
			reason,
			thread: '',
		}),
	);
}

async function views() {
	const mail = await fixture.run(['--mail', 'status'], 'alpha');
	const work = await fixture.run(['--work'], 'alpha');
	expect(mail.code).toBe(0);
	expect(work.code).toBe(0);
	return [
		JSON.parse(mail.out) as unknown,
		(JSON.parse(work.out) as { delivery: unknown }).delivery,
	];
}

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const) {
	test(`${provider}: acknowledgment is visible before receiver refresh, without promoting health`, async () => {
		await writeFile(
			join(fixture.records, 'alpha.json'),
			JSON.stringify(newRecord('alpha', fixture.root, provider)),
		);
		await save();
		for (const view of await views())
			expect(view).toMatchObject({
				state: 'unconfirmed',
				readinessConfirmed: false,
				reason: awaitingReadinessReason,
			});
		const ready = await fixture.run(['--mail', 'ready', 'test-launch'], 'alpha');
		expect(ready.code).toBe(0);
		const before = await readFile(join(runtime, 'test-launch.json'), 'utf8');
		for (const view of await views())
			expect(view).toMatchObject({
				state: 'unconfirmed',
				readinessConfirmed: true,
				reason: 'Launch readiness acknowledged. Retained receiver status does not confirm delivery health.',
			});
		expect(await readFile(join(runtime, 'test-launch.json'), 'utf8')).toBe(before);
		expect(await readFile(fixture.capture, 'utf8')).toBe('');
	});
}

test('old or mismatched readiness cannot confirm the current launch', async () => {
	await save();
	await writeFile(join(runtime, 'old-launch.ready'), 'old-launch');
	await writeFile(join(runtime, 'test-launch.ready'), 'old-launch');
	for (const view of await views())
		expect(view).toMatchObject({
			readinessConfirmed: false,
			reason: awaitingReadinessReason,
		});
});

test('an exited unconfirmed receiver is not promised a future refresh or reported healthy', async () => {
	const child = Bun.spawn([process.execPath, '-e', ''], {
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'ignore',
		windowsHide: true,
	});
	expect(await child.exited).toBe(0);
	expect(processAlive(child.pid)).toBe(false);
	await save('unconfirmed', awaitingReadinessReason, child.pid);
	await writeFile(join(runtime, 'test-launch.ready'), 'test-launch');
	const before = await readFile(join(runtime, 'test-launch.json'), 'utf8');
	for (const view of await views())
		expect(view).toMatchObject({
			state: 'unconfirmed',
			readinessConfirmed: true,
			reason: 'Launch readiness acknowledged. Retained receiver status does not confirm delivery health.',
		});
	expect(await readFile(join(runtime, 'test-launch.json'), 'utf8')).toBe(before);
});

test('acknowledgment does not replace failure or uncertainty reasons', async () => {
	await writeFile(join(runtime, 'test-launch.ready'), 'test-launch');
	for (const state of ['queued-only', 'unconfirmed']) {
		const reason =
			'Provider input may have begun; inspect the delivery outcome before retrying.';
		await save(state, reason);
		for (const view of await views())
			expect(view).toMatchObject({
				state,
				reason,
				readinessConfirmed: true,
			});
	}
});
