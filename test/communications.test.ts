import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
beforeEach(async () => {
	fixture = await mailHarness();
});
afterEach(async () => {
	await fixture.dispose();
});

test('halt persists across commands, blocks all mail sends and receipts, but preserves reads', async () => {
	const sent = await fixture.run(['--mail', 'send-self', 'beta', 'Existing work'], 'alpha');
	expect(sent.code).toBe(0);
	const id = (JSON.parse(sent.out) as { id: string }).id;
	expect((await fixture.run(['--comms', 'halt'])).code).toBe(0);
	expect((await fixture.run(['--comms', 'status'])).out).toContain('Halt');
	expect((await fixture.run(['--mail', 'receive'], 'beta')).out).toContain('Existing work');
	for (const [agent, args] of [
		['alpha', ['--mail', 'send-self', 'beta', 'new work']],
		['beta', ['--mail', 'reply', id, 'reply']],
		['beta', ['--mail', 'confirm', id, 'confirmed']],
		['', ['--mail', 'send', 'alpha', 'beta', 'operator send']],
	] as const) {
		const result = await fixture.run([...args], agent);
		expect(result.code).toBe(1);
		expect(result.error).toContain('paused');
	}
	expect(
		await readdir(join(fixture.records, 'mailboxes', 'alpha', 'inbox')).catch(() => []),
	).toEqual([]);
	expect((await fixture.run(['--comms', 'proceed'], 'alpha')).code).toBe(1);
	expect((await fixture.run(['--comms', 'status'])).out).toContain('Halt');
	expect((await fixture.run(['--comms', 'proceed'])).code).toBe(0);
	expect((await fixture.run(['--mail', 'receive'], 'beta')).code).toBe(0);
	// Suppressed receipts are not queued to burst out after the all-clear.
	expect(
		await readdir(join(fixture.records, 'mailboxes', 'alpha', 'inbox')).catch(() => []),
	).toEqual([]);
	expect((await fixture.run(['--mail', 'reply', id, 'Now allowed'], 'beta')).code).toBe(0);
});

test('only the operator changes communication state; agent attempts preserve the exact record', async () => {
	const path = join(fixture.records, 'communications', 'state.json');
	for (const agent of ['alpha', 'beta']) {
		const denied = await fixture.run(['--comms', 'halt'], agent);
		expect(denied.code).toBe(1);
		expect(denied.error).toContain('human operator only');
	}
	expect(await Bun.file(path).exists()).toBe(false);
	expect((await fixture.run(['--comms', 'halt'])).code).toBe(0);
	const halted = await Bun.file(path).text();
	expect(JSON.parse(halted)).toMatchObject({
		paused: true,
		source: 'local',
		attribution: { channel: 'cli', actor: { kind: 'operator', id: 'operator' } },
	});
	for (const action of ['halt', 'proceed']) {
		const denied = await fixture.run(['--comms', action], 'alpha');
		expect(denied.code).toBe(1);
		expect(denied.error).toContain('human operator only');
		expect(await Bun.file(path).text()).toBe(halted);
	}
	expect((await fixture.run(['--comms', 'status'], 'alpha')).code).toBe(0);
	expect((await fixture.run(['--comms', 'proceed'])).code).toBe(0);
	expect(await Bun.file(path).json()).toMatchObject({
		paused: false,
		attribution: { channel: 'cli', actor: { kind: 'operator', id: 'operator' } },
	});
});

test('agent Room and mail text cannot masquerade as an operator halt', async () => {
	expect((await fixture.run(['--room', 'send', 'halt'], 'alpha')).code).toBe(0);
	expect((await fixture.run(['--mail', 'send-self', 'beta', 'halt'], 'alpha')).code).toBe(0);
	expect((await fixture.run(['--comms', 'status'], 'beta')).out).toContain('Proceed');
	expect(await Bun.file(join(fixture.records, 'communications', 'state.json')).exists()).toBe(
		false,
	);
});

test('malformed attribution refuses sending without exposing the stored value', async () => {
	expect((await fixture.run(['--comms', 'halt'])).code).toBe(0);
	const path = join(fixture.records, 'communications', 'state.json');
	const state = (await Bun.file(path).json()) as Record<string, unknown>;
	await writeFile(
		path,
		JSON.stringify({ ...state, paused: false, attribution: 'PRIVATE_CANARY' }),
	);
	const refused = await fixture.run(['--mail', 'send-self', 'beta', 'must not send'], 'alpha');
	expect(refused.code).toBe(1);
	expect(refused.error).toContain('Invalid communication state');
	expect(refused.error).not.toContain('PRIVATE_CANARY');
});
