import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
beforeEach(async () => {
	fixture = await mailHarness();
});
afterEach(async () => {
	await fixture.dispose();
});
const offlineTest = process.platform === 'win32' ? test : test.skip;
async function invoke(action: string, overrides: Record<string, string> = {}) {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			'--preload',
			join(import.meta.dir, 'fixtures/checkpoint-offline.ts'),
			join(import.meta.dir, '../scripts/migrate-checkpoints.ts'),
			'--offline',
			action,
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
async function setup() {
	const root = join(fixture.records, 'runtime/alpha');
	await mkdir(root, { recursive: true });
	await writeFile(join(root, 'room.cursor'), '42');
	const token = randomUUID();
	const state = JSON.stringify({
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
	});
	await writeFile(join(root, 'checkpoint.json'), state);
	return { root, state };
}

offlineTest(
	'verified process absence clears an uncertain PID without changing retained evidence',
	async () => {
		const { root, state } = await setup();
		const path = join(root, 'uncertain.json');
		const record = JSON.stringify({ pid: process.pid, reason: 'uncertain signal-zero probe' });
		await writeFile(path, record);
		const absent = { SUMMON_TEST_PROCESS_START: 'absent' };
		const checked = await invoke('--preflight', absent);
		expect(checked.error).toBe('');
		expect(checked.code).toBe(0);
		expect(JSON.parse(checked.out) as unknown).toMatchObject({ ready: true });
		expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(state);
		expect((await invoke('--apply', absent)).code).toBe(0);
		expect(
			JSON.parse(await fixture.read('runtime/alpha/checkpoint.json')) as unknown,
		).toMatchObject({ version: 2 });
		expect(await readFile(path, 'utf8')).toBe(record);
		expect(await fixture.read('runtime/alpha/room.cursor')).toBe('42');
	},
);

offlineTest(
	'actual CIM query requires a matching positive control before reporting absence',
	async () => {
		const { root, state } = await setup();
		const path = join(root, 'controlled.json');
		const record = JSON.stringify({ pid: process.pid });
		await writeFile(path, record);
		for (const control of ['missing', 'wrong', 'error']) {
			const checked = await invoke('--apply', { SUMMON_TEST_CIM_CONTROL: control });
			expect(checked.code).toBe(1);
			expect(checked.error).toContain(path);
			expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(state);
		}
		expect((await invoke('--preflight', { SUMMON_TEST_CIM_CONTROL: 'matching' })).code).toBe(0);
		expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(state);
		expect(await readFile(path, 'utf8')).toBe(record);
	},
	15000,
);

offlineTest(
	'reused Windows PID permits migration without deleting historical receiver evidence',
	async () => {
		const { root, state } = await setup();
		const path = join(root, `${randomUUID()}.json`);
		const record = JSON.stringify({ pid: process.pid, reason: 'retained receiver' });
		await writeFile(path, record);
		await utimes(path, new Date('2000-01-01'), new Date('2000-01-01'));
		const checked = await invoke('--preflight');
		expect(checked.error).toBe('');
		expect(checked.code).toBe(0);
		expect(JSON.parse(checked.out) as unknown).toMatchObject({ ready: true });
		expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(state);
		expect((await invoke('--apply')).code).toBe(0);
		expect(
			JSON.parse(await fixture.read('runtime/alpha/checkpoint.json')) as unknown,
		).toMatchObject({ version: 2 });
		expect(await readFile(path, 'utf8')).toBe(record);
		expect(await fixture.read('runtime/alpha/room.cursor')).toBe('42');
	},
	15000,
);

offlineTest(
	'live receiver and invalid PID refuse with exact metadata location and leave state unchanged',
	async () => {
		const { root, state } = await setup();
		const path = join(root, 'live.json');
		for (const pid of [process.pid, 0, -1, '123', 1.5]) {
			await writeFile(path, JSON.stringify({ pid }));
			const result = await invoke('--apply');
			expect(result.code).toBe(1);
			expect(result.error).toContain('Active or unverifiable receiver');
			expect(result.error).toContain(path);
			expect(result.error).toContain(
				`PID ${typeof pid === 'number' && Number.isSafeInteger(pid) ? pid : 'invalid'}`,
			);
			expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(state);
		}
	},
);

offlineTest(
	'unavailable, invalid and equal creation-time evidence never clears a live PID',
	async () => {
		const { root, state } = await setup();
		const path = join(root, 'old.json');
		await writeFile(path, JSON.stringify({ pid: process.pid }));
		await utimes(path, new Date(1000), new Date(1000));
		for (const value of [
			'',
			'not-a-time',
			'0',
			'-1',
			'1000',
			'absent\nextra',
			String(Date.now() + 86400000),
		]) {
			const result = await invoke('--apply', { SUMMON_TEST_PROCESS_START: value });
			expect(result.code).toBe(1);
			expect(result.error).toContain(path);
			expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(state);
		}
		expect(
			(
				await invoke('--apply', {
					SUMMON_TEST_PROCESS_START: '1001',
					SUMMON_TEST_PROCESS_START_EXIT: '1',
				})
			).code,
		).toBe(1);
		expect(
			(
				await invoke('--apply', {
					SUMMON_TEST_PROCESS_START: 'absent',
					SUMMON_TEST_PROCESS_START_EXIT: '1',
				})
			).code,
		).toBe(1);
		expect((await invoke('--preflight', { SUMMON_TEST_PROCESS_START: '1001' })).code).toBe(0);
		expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(state);
	},
);

offlineTest.each([
	'receiver',
	'session.lock',
	'receiver-pending-fixture',
	'session-pending-fixture',
])(
	'owner and child instance checks retain %s without reclaiming it',
	async (folder) => {
		const { root, state } = await setup();
		const directory = join(root, folder);
		await mkdir(directory);
		const path = join(directory, 'owner.json');
		const owner = JSON.stringify({
			pid: process.pid,
			childPid: process.pid,
			nonce: randomUUID(),
		});
		await writeFile(path, owner);
		expect((await invoke('--preflight')).error).toContain(
			'Active or unverifiable runtime owner',
		);
		await utimes(path, new Date(1000), new Date(1000));
		// Parent identity is stale, but a child whose birth predates the record still vetoes.
		await writeFile(
			path,
			JSON.stringify({ pid: 2147483647, childPid: process.pid, nonce: randomUUID() }),
		);
		const liveChild = await invoke('--apply');
		expect(liveChild.code).toBe(1);
		expect(liveChild.error).toContain(path);
		expect(liveChild.error).toContain(`PID ${process.pid}`);
		await writeFile(path, owner);
		await utimes(path, new Date(1000), new Date(1000));
		expect((await invoke('--preflight')).code).toBe(0);
		expect(await readFile(path, 'utf8')).toBe(owner);
		expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(state);
	},
	15000,
);
