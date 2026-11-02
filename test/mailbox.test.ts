import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { newRecord, rememberSession } from '../src/store.ts';

let root: string;
let records: string;
let capture: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-mail-test-'));
	records = join(root, 'agents');
	capture = join(root, 'launches.jsonl');
	await mkdir(records);
	await writeFile(capture, '');
	for (const [name, provider] of [
		['carl', 'claude'],
		['auden', 'codex'],
		['grunt', 'grok'],
	] as const) {
		const record = newRecord(name, root, provider);
		rememberSession(record, 'existing-session');
		await writeFile(join(records, `${name}.json`), JSON.stringify(record));
	}
});

afterEach(async () => {
	const target = resolve(root);
	if (
		dirname(target) !== resolve(tmpdir()) ||
		!basename(target).startsWith('summon-mail-test-')
	) {
		throw new Error('Refusing to remove an unexpected test directory.');
	}
	await rm(target, { recursive: true, force: true });
});

async function invoke(args: string[], extraEnv: Record<string, string> = {}) {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			'--preload',
			join(import.meta.dir, 'fixtures/capture-launch.ts'),
			join(import.meta.dir, '../src/cli.ts'),
			...args,
		],
		cwd: root,
		env: {
			...process.env,
			SUMMON_HOME: records,
			CODEX_HOME: join(root, 'codex'),
			SUMMON_TEST_CAPTURE: capture,
			SUMMON_TEST_EXIT: '0',
			SUMMON_TEST_SPAWN_ERROR: '0',
			...extraEnv,
		},
		stdin: new Blob(['yes\n']),
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

test('messages persist across checks and archive only on acknowledgement', async () => {
	const before = await readFile(join(records, 'auden.json'), 'utf8');
	const sent = await invoke([
		'--mail',
		'send',
		'Carl',
		'Auden',
		'Please check /work/api.\nThanks.',
	]);
	expect(sent.code).toBe(0);
	const inbox = join(records, 'mailboxes', 'auden', 'inbox');
	const files = await readdir(inbox);
	expect(files).toHaveLength(1);
	const file = files[0];
	if (!file) throw new Error('Expected a message.');
	const body = await readFile(join(inbox, file), 'utf8');
	expect(body).toContain('From: carl\nTo: auden\n');
	expect(body).toContain('Please check /work/api.\nThanks.');
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const checked = await invoke(['--mail', 'check', 'auden']);
		expect(checked.code).toBe(0);
		expect(checked.stdout).toContain(body);
	}
	const id = file.slice(0, -3);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		expect((await invoke(['--mail', 'ack', 'auden', id])).code).toBe(0);
	}
	expect(await readdir(inbox)).toEqual([]);
	expect(await readFile(join(records, 'mailboxes', 'auden', 'archive', file), 'utf8')).toBe(body);
	expect((await invoke(['--mail', 'check', 'auden'])).stdout).toContain('0 pending');
	expect(await readFile(join(records, 'auden.json'), 'utf8')).toBe(before);
	expect(await readFile(capture, 'utf8')).toBe('');
});

test('concurrent senders retain every complete message and ignore unfinished writes', async () => {
	const results = await Promise.all(
		Array.from({ length: 12 }, (_, index) =>
			invoke(['--mail', 'send', 'carl', 'auden', `Request ${index}.`]),
		),
	);
	expect(results.filter((result) => result.code !== 0)).toEqual([]);
	const inbox = join(records, 'mailboxes', 'auden', 'inbox');
	expect(await readdir(inbox)).toHaveLength(12);
	await writeFile(join(inbox, 'unfinished.tmp'), 'Do not deliver');
	const checked = await invoke(['--mail', 'check', 'auden']);
	expect(checked.code).toBe(0);
	expect(checked.stdout).toContain('12 pending');
	expect(checked.stdout).not.toContain('Do not deliver');
	for (let index = 0; index < 12; index += 1) {
		expect(checked.stdout).toContain(`Request ${index}.`);
	}
});

test('invalid commands, unregistered names, empty messages and traversal fail without delivery', async () => {
	for (const args of [
		['send', 'carl', 'unknown', 'Request'],
		['send', 'unknown', 'auden', 'Request'],
		['send', '../carl', 'auden', 'Request'],
		['send', 'carl', '../auden', 'Request'],
		['send', 'carl', 'auden', '   '],
		['send', 'carl', 'auden'],
		['send', 'carl', 'auden', 'Request', 'extra'],
		['check', 'unknown'],
		['check', 'auden', 'extra'],
		['ack', 'auden', '../outside'],
		['ack', 'auden', '00000000-0000-4000-8000-000000000000'],
	]) {
		expect((await invoke(['--mail', ...args])).code).toBe(1);
	}
	expect((await invoke(['--mail', 'check', 'auden'])).stdout).toContain('0 pending');
	expect(await readFile(capture, 'utf8')).toBe('');
});

test.each(['carl', 'auden', 'grunt'])(
	'startup and resume of %s carry mailbox instructions without consuming mail',
	async (name) => {
		expect((await invoke(['--mail', 'send', 'carl', name, 'Please review.'])).code).toBe(0);
		for (const args of [
			[name, '--same-window'],
			['__session', name],
		]) {
			const result = await invoke(args, { SUMMON_HOME: 'agents' });
			expect(result.code).toBe(0);
		}
		const launches = (await readFile(capture, 'utf8')).trim().split('\n');
		expect(launches).toHaveLength(2);
		for (const line of launches) {
			const launch = JSON.parse(line) as { cmd: string[] };
			if (name === 'carl') {
				expect(launch.cmd.at(-2)).toBe('--');
				expect(launch.cmd).not.toContain('--append-system-prompt');
			}
			const promptFile = join(records, 'runtime', name, 'session-prompt.md');
			expect(launch.cmd.at(-1)).toContain(JSON.stringify(promptFile));
			const prompt = await readFile(promptFile, 'utf8');
			expect(prompt).toContain(join(records, 'mailboxes', name));
			expect(prompt).toContain('Pending messages at launch: 1');
			expect(prompt).toContain(
				'At startup and before historical catch-up, run summon --current-requests --format text.',
			);
			expect(prompt.indexOf('run summon --current-requests')).toBeLessThan(
				prompt.indexOf('Then run summon --checkpoint.'),
			);
			expect(prompt).toContain('Pass every page receipt in order');
			expect(prompt).toContain('Do not repeat empty checks');
			expect(prompt).toContain(`you may read only your own inbox and archive (${name})`);
			expect(prompt).toContain(
				"Never read, list, search, or acknowledge another agent's mailbox",
			);
			expect(prompt).toContain(
				'or direct filesystem access. This includes messages you sent',
			);
		}
		expect((await invoke(['--mail', 'check', name])).stdout).toContain('Please review.');
	},
);

test.each(['claude', 'codex', 'grok'])(
	'a first %s launch sets up an empty mailbox',
	async (provider) => {
		const result = await invoke(['new-agent', '--using', provider, '--same-window']);
		expect(result.code).toBe(0);
		const launch = JSON.parse((await readFile(capture, 'utf8')).trim()) as { cmd: string[] };
		if (provider === 'claude') expect(launch.cmd.at(-2)).toBe('--');
		const promptFile = join(records, 'runtime', 'new-agent', 'session-prompt.md');
		expect(launch.cmd.at(-1)).toContain(JSON.stringify(promptFile));
		const prompt = await readFile(promptFile, 'utf8');
		expect(prompt).toContain('Pending messages at launch: 0');
		expect(prompt).toContain('summon --checkpoint');
		expect(prompt).toContain('you may read only your own inbox and archive (new-agent)');
		expect(await readdir(join(records, 'mailboxes', 'new-agent', 'inbox'))).toEqual([]);
	},
);
