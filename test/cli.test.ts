import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { platform, tmpdir } from 'node:os';
import {
	newRecord,
	providers as registeredProviders,
	rememberSession,
	type AgentRecord,
	type Provider,
} from '../src/store.ts';

interface Launch {
	cmd: string[];
	cwd?: string;
}
let root: string;
let project: string;
let records: string;
let capture: string;
const providers = [...registeredProviders];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-cli-test-'));
	project = join(root, 'project with spaces');
	records = join(root, 'agents');
	capture = join(root, 'launches.jsonl');
	await mkdir(project);
	await mkdir(records);
});

afterEach(async () => {
	const target = resolve(root);
	if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('summon-cli-test-')) {
		throw new Error('Refusing to remove an unexpected test directory.');
	}
	await rm(target, { recursive: true, force: true });
});

async function invoke(args: string[], extraEnv: Record<string, string> = {}) {
	await writeFile(capture, '');
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			'--preload',
			join(import.meta.dir, 'fixtures/capture-launch.ts'),
			join(import.meta.dir, '../src/cli.ts'),
			...args,
		],
		cwd: project,
		env: {
			...process.env,
			SUMMON_HOME: records,
			CODEX_HOME: join(root, 'codex'),
			SUMMON_TEST_CAPTURE: capture,
			SUMMON_TEST_EXIT: '0',
			SUMMON_TEST_SPAWN_ERROR: '0',
			...extraEnv,
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const output = (await readFile(capture, 'utf8')).trim();
	const launches = output ? output.split('\n').map((line) => JSON.parse(line) as Launch) : [];
	return { stdout, stderr, code, launches };
}

async function seed(provider: Provider): Promise<AgentRecord> {
	const record = newRecord('Member', project, provider);
	record.notes = 'Keep my existing context.';
	rememberSession(record, 'existing-session');
	await writeFile(join(records, 'member.json'), JSON.stringify(record));
	return record;
}

async function saved(): Promise<AgentRecord> {
	return JSON.parse(await readFile(join(records, 'member.json'), 'utf8')) as AgentRecord;
}

describe('named CLI sessions', () => {
	test.each(providers)('plain names resume their registered %s CLI', async (provider) => {
		const original = await seed(provider);
		const result = await invoke(['member', '--same-window']);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe('');
		expect(result.launches).toHaveLength(1);
		const launch = result.launches[0];
		expect(launch?.cmd.slice(0, 2)).toEqual([
			provider,
			provider === 'codex' ? 'resume' : '--resume',
		]);
		expect(launch?.cmd).toContain('existing-session');
		expect(launch?.cmd.at(-1)).toContain(original.notes);
		expect(launch?.cwd).toBe(project);
		const record = await saved();
		expect(record.provider).toBe(provider);
		expect(record.notes).toBe(original.notes);
		expect(record.createdAt).toBe(original.createdAt);
		expect(record.sessions).toHaveLength(1);
		expect(record.sessions[0]?.createdAt).toBe(original.sessions[0]?.createdAt);
	});

	test.each(providers)('new names save %s and reuse it without --using', async (provider) => {
		const choice = provider === 'codex' ? ['--using', 'codex'] : [];
		const first = await invoke([
			'member',
			...choice,
			'--same-window',
			'--note',
			'New context.',
		]);
		expect(first.code).toBe(0);
		expect(first.launches[0]?.cmd[0]).toBe(provider);
		expect(first.launches[0]?.cmd).not.toContain('--resume');
		expect(first.launches[0]?.cmd).not.toContain('resume');
		const record = await saved();
		expect(record.version).toBe(2);
		expect(record.provider).toBe(provider);
		expect(record.notes).toBe('New context.');
		expect(record.sessions).toHaveLength(1);
		const id = record.sessions[0]?.id;
		if (!id) throw new Error('Expected a saved session ID.');
		if (provider === 'codex') expect(id).toBe('test-codex-session');
		else expect(first.launches[0]?.cmd.slice(0, 3)).toEqual(['claude', '--session-id', id]);

		const second = await invoke(['member', '--same-window']);
		expect(second.code).toBe(0);
		expect(second.launches[0]?.cmd[0]).toBe(provider);
		expect(second.launches[0]?.cmd).toContain(id);
		expect(second.launches[0]?.cmd[1]).toBe(provider === 'codex' ? 'resume' : '--resume');
		expect((await saved()).sessions).toHaveLength(1);
	});

	test.each(providers)('matching --using is accepted for %s', async (provider) => {
		await seed(provider);
		const result = await invoke(['member', '--using', provider, '--same-window']);
		expect(result.code).toBe(0);
		expect(result.launches[0]?.cmd[0]).toBe(provider);
	});

	test.each(providers)('conflicting --using cannot change a %s record', async (provider) => {
		await seed(provider);
		const before = await readFile(join(records, 'member.json'), 'utf8');
		const other = provider === 'codex' ? 'claude' : 'codex';
		const result = await invoke([
			'member',
			'--using',
			other,
			'--note',
			'Must not be appended.',
			'--cwd',
			root,
			'--same-window',
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('registered with ' + provider);
		expect(result.launches).toEqual([]);
		expect(await readFile(join(records, 'member.json'), 'utf8')).toBe(before);
	});

	test.each(providers)(
		'new-terminal launches for %s pass only the registered name',
		async (provider) => {
			await seed(provider);
			const result = await invoke(['member']);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain('Summoned Member with ' + provider);
			expect(result.launches).toHaveLength(1);
			const cmd = result.launches[0]?.cmd;
			if (!cmd) throw new Error('Expected a terminal command.');
			expect(cmd[0]).not.toBe(provider);
			if (platform() === 'win32') {
				expect(cmd[0]).toBe('wt.exe');
				expect(cmd.slice(-2)).toEqual(['__session', 'member']);
				expect(cmd).toContain(project);
			} else {
				expect(cmd.join(' ')).toContain("'__session' 'member'");
				expect(cmd.join(' ')).not.toContain("'__session' 'member' '" + provider + "'");
			}
		},
	);

	test.each(providers)('the internal runner loads the saved %s CLI', async (provider) => {
		await seed(provider);
		const result = await invoke(['__session', 'Member']);
		expect(result.code).toBe(0);
		expect(result.launches[0]?.cmd[0]).toBe(provider);
	});

	test('the internal runner rejects provider overrides and paths', async () => {
		await seed('codex');
		const before = await readFile(join(records, 'member.json'), 'utf8');
		for (const args of [
			['__session', 'member', 'claude'],
			['__session', '../member'],
		]) {
			const result = await invoke(args);
			expect(result.code).toBe(1);
			expect(result.launches).toEqual([]);
		}
		expect(await readFile(join(records, 'member.json'), 'utf8')).toBe(before);
	});

	test('invalid provider choices fail before registration', async () => {
		for (const args of [
			['member', '--using'],
			['member', '--using', 'unknown'],
		]) {
			const result = await invoke(args);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('--using must be claude or codex');
			expect(result.launches).toEqual([]);
			expect(await readdir(records)).toEqual([]);
		}
	});

	test('invalid records are not rewritten or launched', async () => {
		const original = await seed('codex');
		const invalid = JSON.stringify({ ...original, provider: 'unknown' });
		await writeFile(join(records, 'member.json'), invalid);
		const result = await invoke(['member', '--same-window']);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Invalid agent record');
		expect(result.launches).toEqual([]);
		expect(await readFile(join(records, 'member.json'), 'utf8')).toBe(invalid);
	});

	test('provider exit codes are preserved', async () => {
		await seed('codex');
		const result = await invoke(['member', '--same-window'], { SUMMON_TEST_EXIT: '17' });
		expect(result.code).toBe(17);
		expect((await saved()).provider).toBe('codex');
	});

	test('a failed first Claude launch removes the unstarted session, not its registration', async () => {
		const result = await invoke(['member', '--same-window'], { SUMMON_TEST_SPAWN_ERROR: '1' });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Simulated launch failure');
		const record = await saved();
		expect(record.provider).toBe('claude');
		expect(record.sessions).toEqual([]);
	});
});
