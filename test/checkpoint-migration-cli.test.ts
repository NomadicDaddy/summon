import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
beforeEach(async () => {
	fixture = await mailHarness();
});
afterEach(async () => {
	await fixture.dispose();
});
const offlineTest = process.platform === 'win32' ? test : test.skip;
async function invoke(
	action: string,
	overrides: Record<string, string> = {},
	deferred: string[] = [],
) {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			'--preload',
			join(import.meta.dir, 'fixtures/checkpoint-offline.ts'),
			join(import.meta.dir, '../scripts/migrate-checkpoints.ts'),
			'--offline',
			action,
			...deferred.flatMap((name) => ['--defer-owner', name]),
		],
		env: {
			...process.env,
			SUMMON_HOME: fixture.records,
			SUMMON_AGENT: '',
			SUMMON_NONCE: '',
			SUMMON_TEST_OFFLINE: '1',
			...overrides,
		},
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	const [out, error, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { out, error, code };
}

offlineTest(
	'explicit hibernated Grok deferral preserves its unread old batch and converts other owners',
	async () => {
		const alpha = await setup('alpha');
		const beta = await setup('beta');
		beta.state.pending.output.changed = true;
		const before = JSON.stringify(beta.state);
		await writeFile(join(beta.root, 'checkpoint.json'), before);
		await writeFile(
			join(fixture.records, 'beta.json'),
			JSON.stringify(newRecord('beta', fixture.root, 'grok')),
		);
		expect((await invoke('--preflight', {}, ['beta'])).error).toContain('hibernated Grok');
		expect((await fixture.run(['--hibernate', 'beta'])).code).toBe(0);
		const record = await fixture.read('beta.json');
		const checked = await invoke('--preflight', {}, ['beta']);
		expect(checked.code).toBe(0);
		expect(JSON.parse(checked.out) as unknown).toMatchObject({
			ready: true,
			owners: ['alpha'],
			deferred: ['beta'],
			deferredUnchanged: true,
		});
		expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(
			JSON.stringify(alpha.state),
		);
		expect(await fixture.read('runtime/beta/checkpoint.json')).toBe(before);
		const applied = await invoke('--apply', {}, ['beta']);
		expect(applied.code).toBe(0);
		expect(JSON.parse(applied.out) as unknown).toMatchObject({
			migrated: true,
			owners: ['alpha'],
			deferred: ['beta'],
			deferredUnchanged: true,
		});
		expect(
			JSON.parse(await fixture.read('runtime/alpha/checkpoint.json')) as unknown,
		).toMatchObject({ version: 2 });
		expect(await fixture.read('runtime/beta/checkpoint.json')).toBe(before);
		expect(await fixture.read('runtime/beta/room.cursor')).toBe('42');
		expect(await fixture.read('beta.json')).toBe(record);
		expect(
			JSON.parse((await fixture.run(['--checkpoint'], 'beta')).out) as unknown,
		).toMatchObject({ hibernated: true, changed: false, more: false });
		expect(await fixture.read('runtime/beta/checkpoint.json')).toBe(before);
		expect((await invoke('--apply', {}, ['beta'])).code).toBe(0);
		expect((await fixture.run(['--unhibernate', 'beta'])).code).toBe(0);
		expect((await fixture.run(['--checkpoint'], 'beta')).error).toContain('offline migration');
		expect(await fixture.read('runtime/beta/checkpoint.json')).toBe(before);
		// The owner later drains with the retained release; here its neutral state is the positive control.
		beta.state.pending.output.changed = false;
		await writeFile(join(beta.root, 'checkpoint.json'), JSON.stringify(beta.state));
		expect((await invoke('--apply')).code).toBe(0);
		expect(
			JSON.parse(await fixture.read('runtime/beta/checkpoint.json')) as unknown,
		).toMatchObject({ version: 2, emptyReceipt: beta.state.pending.token });
	},
);

offlineTest(
	'deferral refuses wrong providers, unknown or active owners and damaged legacy state',
	async () => {
		await setup('alpha');
		const beta = await setup('beta');
		expect((await fixture.run(['--hibernate', 'beta'])).code).toBe(0);
		expect((await invoke('--apply', {}, ['beta'])).error).toContain('hibernated Grok');
		expect((await invoke('--apply', {}, ['unknown'])).error).toContain('Unregistered deferred');
		await writeFile(
			join(fixture.records, 'beta.json'),
			JSON.stringify(newRecord('beta', fixture.root, 'grok')),
		);
		expect((await fixture.run(['--hibernate', 'beta'])).code).toBe(0);
		await mkdir(join(beta.root, 'receiver'));
		await writeFile(
			join(beta.root, 'receiver/owner.json'),
			JSON.stringify({ pid: process.pid, nonce: randomUUID() }),
		);
		expect((await invoke('--apply', {}, ['beta'])).error).toContain('Active or unverifiable');
		expect(await fixture.read('runtime/alpha/checkpoint.json')).not.toContain('"version":2');
		await writeFile(join(beta.root, 'receiver/owner.json'), '{}');
		expect((await invoke('--apply', {}, ['beta'])).error).toContain('Active or unverifiable');
		await rename(join(beta.root, 'receiver'), join(beta.root, 'retained-fixture-owner'));
		await writeFile(join(beta.root, 'checkpoint.json'), '{"unknown":true}');
		expect((await invoke('--apply', {}, ['beta'])).error).toContain('valid legacy checkpoint');
		expect((await invoke('--apply', {}, ['beta', 'beta'])).error).toContain(
			'unique registered slug',
		);
		expect(await fixture.read('runtime/alpha/checkpoint.json')).not.toContain('"version":2');
	},
);
async function setup(name: string) {
	const root = join(fixture.records, 'runtime', name);
	await mkdir(root, { recursive: true });
	await writeFile(join(root, 'room.cursor'), '42');
	const token = randomUUID();
	const state = {
		seen: [],
		mailNext: null,
		holdNext: null,
		pending: {
			token,
			room: 42,
			seen: [],
			mailNext: null,
			holdNext: null,
			readMail: [],
			output: { paused: false, receipt: token, changed: false, more: false },
		},
	};
	await writeFile(join(root, 'checkpoint.json'), JSON.stringify(state));
	return { root, state };
}

offlineTest(
	'offline command preflights every owner before writing, preserves cursors and retains rollback plan',
	async () => {
		const alpha = await setup('alpha');
		const beta = await setup('beta');
		beta.state.pending.output.changed = true;
		await writeFile(join(beta.root, 'checkpoint.json'), JSON.stringify(beta.state));
		expect((await invoke('--apply')).error).toContain('Unsettled checkpoint batch');
		expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(
			JSON.stringify(alpha.state),
		);
		beta.state.pending.output.changed = false;
		await writeFile(join(beta.root, 'checkpoint.json'), JSON.stringify(beta.state));
		const checked = await invoke('--preflight');
		expect(checked.code).toBe(0);
		expect(JSON.parse(checked.out) as unknown).toMatchObject({
			ready: true,
			owners: ['alpha', 'beta'],
		});
		expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(
			JSON.stringify(alpha.state),
		);
		const migrated = await invoke('--apply');
		expect(migrated.code).toBe(0);
		const result = JSON.parse(migrated.out) as { backup: string };
		expect(
			JSON.parse(await readFile(join(result.backup, 'plan.json'), 'utf8')) as unknown,
		).toHaveLength(2);
		expect(
			JSON.parse(await fixture.read('runtime/alpha/checkpoint.json')) as unknown,
		).toMatchObject({ version: 2, emptyReceipt: alpha.state.pending.token });
		expect(await fixture.read('runtime/alpha/room.cursor')).toBe('42');
		expect(await fixture.read('runtime/beta/room.cursor')).toBe('42');
		expect((await invoke('--apply')).code).toBe(0);
	},
);

offlineTest(
	'live process inventory, live receiver and malformed owner each veto migration',
	async () => {
		const alpha = await setup('alpha');
		expect((await invoke('--apply', { SUMMON_TEST_INVENTORY: '123' })).error).toContain(
			'still present',
		);
		expect((await invoke('--apply', { SUMMON_TEST_INVENTORY_EXIT: '1' })).error).toContain(
			'Could not verify',
		);
		await mkdir(join(alpha.root, 'receiver'));
		await writeFile(
			join(alpha.root, 'receiver/owner.json'),
			JSON.stringify({ pid: process.pid, nonce: randomUUID() }),
		);
		expect((await invoke('--apply')).error).toContain('Active or unverifiable runtime owner');
		await writeFile(join(alpha.root, 'receiver/owner.json'), '{}');
		expect((await invoke('--apply')).error).toContain('Active or unverifiable runtime owner');
		expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(
			JSON.stringify(alpha.state),
		);
	},
);

offlineTest(
	'terminal empty receipt permits stale preceding pagination without changing source cursors',
	async () => {
		const alpha = await setup('alpha');
		const before = JSON.stringify({
			...alpha.state,
			mailNext: 'preceding-mail-page',
			holdNext: 'preceding-hold-page',
		});
		await writeFile(join(alpha.root, 'checkpoint.json'), before);
		const checked = await invoke('--preflight');
		expect(checked.code).toBe(0);
		expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(before);
		expect((await invoke('--apply')).code).toBe(0);
		expect(
			JSON.parse(await fixture.read('runtime/alpha/checkpoint.json')) as unknown,
		).toMatchObject({ version: 2, emptyReceipt: alpha.state.pending.token });
		expect(await fixture.read('runtime/alpha/room.cursor')).toBe('42');
		alpha.state.pending.output.changed = true;
		await writeFile(join(alpha.root, 'checkpoint.json'), JSON.stringify(alpha.state));
		const refused = await invoke('--apply');
		expect(refused.code).toBe(1);
		expect(refused.error).toContain('Unsettled checkpoint batch for alpha');
		expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(
			JSON.stringify(alpha.state),
		);
	},
);

offlineTest(
	'a deferred owner changing after preflight prevents all conversion and is never restored',
	async () => {
		const alpha = await setup('alpha');
		await setup('beta');
		await writeFile(
			join(fixture.records, 'beta.json'),
			JSON.stringify(newRecord('beta', fixture.root, 'grok')),
		);
		expect((await fixture.run(['--hibernate', 'beta'])).code).toBe(0);
		const result = await invoke('--apply', { SUMMON_TEST_CHANGE_DEFERRED: '1' }, ['beta']);
		expect(result.code).toBe(1);
		expect(result.error).toContain('Deferred checkpoint changed after preflight');
		expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(
			JSON.stringify(alpha.state),
		);
		expect(await fixture.read('runtime/beta/checkpoint.json')).toBe(
			'{"changed-by-fixture":true}',
		);
	},
);
