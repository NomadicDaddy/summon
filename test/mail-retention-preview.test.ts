import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

let root: string;
const owner = 'fixture-codex';
const id = '759cf15b-a91c-4c3a-9537-5ed0dbb9d732';
const secondId = '759cf15b-a91c-4c3a-9537-5ed0dbb9d733';
const retentionTest = test.skipIf(process.platform !== 'win32');

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-retention-test-'));
	await mkdir(join(root, 'mailboxes', owner, 'inbox'), { recursive: true });
});

afterEach(async () => {
	const target = resolve(root);
	if (
		dirname(target) !== resolve(tmpdir()) ||
		!basename(target).startsWith('summon-retention-test-')
	)
		throw new Error('Unexpected disposable retention fixture path.');
	await rm(target, { recursive: true, force: true });
});

async function invoke(args: string[] = [], agent = owner) {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			join(import.meta.dir, '../src/cli.ts'),
			'--mail-retention',
			'preview',
			...args,
		],
		env: {
			...process.env,
			SUMMON_HOME: root,
			SUMMON_AGENT: agent,
			SUMMON_NONCE: 'fixture-launch',
		},
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

function result(text: string) {
	return JSON.parse(text) as {
		readOnly: boolean;
		applyAvailable: boolean;
		eligibleCount: number;
		coverage: Record<string, boolean>;
		next: string | null;
		rows: { path: string; rule: string; sha256: string | null; disposition: string }[];
	};
}

async function message(messageId = id, section = 'inbox', body = 'A private fixture body') {
	const directory = join(root, 'mailboxes', owner, section);
	await mkdir(directory, { recursive: true });
	const path = join(directory, `${messageId}.md`);
	await writeFile(path, body);
	return path;
}

retentionTest(
	'real CLI keeps inbox, archives, decisions and markers without initializing or changing the store',
	async () => {
		const path = await message();
		await message(secondId, 'archive');
		await mkdir(join(root, 'mailboxes', owner, 'holds'));
		await writeFile(
			join(root, 'mailboxes', owner, 'holds', `${id}.json`),
			'{"decision":"pending"}',
		);
		await mkdir(join(root, 'mailboxes', owner, 'delivery'));
		await writeFile(join(root, 'mailboxes', owner, 'delivery', `${id}.read`), 'already read');
		const before = (await readdir(root, { recursive: true })).sort();
		const run = await invoke();
		expect(run.code).toBe(0);
		expect(run.stdout).not.toContain('A private fixture body');
		const value = result(run.stdout);
		expect(value.readOnly).toBe(true);
		expect(value.applyAvailable).toBe(false);
		expect(value.eligibleCount).toBe(0);
		expect(value.rows).toHaveLength(4);
		expect(value.rows.every((row) => row.disposition === 'KEEP')).toBe(true);
		expect(value.rows.find((row) => row.path === `inbox/${id}.md`)?.sha256).toBe(
			createHash('sha256')
				.update(await readFile(path))
				.digest('hex'),
		);
		expect(value.rows.map((row) => row.rule)).toContain('decision-evidence');
		expect(value.rows.map((row) => row.rule)).toContain('delivery-markers-retained');
		expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
		expect(await readFile(path, 'utf8')).toBe('A private fixture body');
	},
);

retentionTest(
	'card/report prefix citations pin all matches and never claim complete external coverage',
	async () => {
		await message(id, 'archive');
		await message(secondId, 'archive');
		const pins = join(root, 'pins.json');
		await writeFile(
			pins,
			JSON.stringify({
				version: 1,
				owner,
				sources: [
					{
						id: 'card-only-report-only',
						sha256: 'a'.repeat(64),
						complete: true,
						citations: ['record759CF15B', `original ${id}`],
					},
				],
			}),
		);
		const run = await invoke(['--pins-file', pins]);
		expect(run.code).toBe(0);
		const value = result(run.stdout);
		expect(value.rows.map((row) => row.rule)).toEqual(['external-pin', 'external-pin']);
		expect(value.coverage.externalSourcesComplete).toBe(false);
		expect(value.coverage.operatorHeadersComplete).toBe(false);
	},
);

retentionTest(
	'pagination refuses inventory changes rather than skipping unseen inputs',
	async () => {
		for (let index = 0; index < 12; index += 1)
			await message(`759cf15b-a91c-4c3a-9537-${String(index).padStart(12, '0')}`);
		const first = result((await invoke()).stdout);
		expect(first.rows).toHaveLength(10);
		expect(first.next).not.toBeNull();
		const last = await invoke(['--cursor', first.next ?? '']);
		expect(last.code).toBe(0);
		expect(result(last.stdout).rows).toHaveLength(2);
		expect(result(last.stdout).next).toBeNull();
		await message();
		const changed = await invoke(['--cursor', first.next ?? '']);
		expect(changed.code).not.toBe(0);
		expect(changed.stderr).toContain('Retention inputs changed');
	},
);

retentionTest(
	'oversized and linked artifacts are retained without hashing their contents',
	async () => {
		await message(id, 'inbox', 'x'.repeat(1_000_001));
		const foreign = join(root, 'foreign.txt');
		await writeFile(foreign, 'must not follow');
		await symlink(foreign, join(root, 'mailboxes', owner, 'inbox', `${secondId}.md`));
		const run = await invoke();
		expect(run.code).toBe(0);
		const value = result(run.stdout);
		expect(value.rows.every((row) => row.sha256 === null)).toBe(true);
		expect(run.stdout).not.toContain('must not follow');
	},
);

retentionTest(
	'changed pin input invalidates the next page and private peer pin files are refused',
	async () => {
		for (let index = 0; index < 11; index += 1)
			await message(`759cf15b-a91c-4c3a-9537-${String(index).padStart(12, '0')}`);
		const pins = join(root, 'pins.json');
		await writeFile(pins, JSON.stringify({ version: 1, owner, sources: [] }));
		const first = result((await invoke(['--pins-file', pins])).stdout);
		expect(first.next).not.toBeNull();
		await writeFile(
			pins,
			JSON.stringify({
				version: 1,
				owner,
				sources: [
					{
						id: 'report',
						sha256: 'a'.repeat(64),
						complete: false,
						citations: ['759cf15b'],
					},
				],
			}),
		);
		const changed = await invoke(['--pins-file', pins, '--cursor', first.next ?? '']);
		expect(changed.code).not.toBe(0);
		expect(changed.stderr).toContain('Retention inputs changed');
		const privatePins = join(root, 'mailboxes', 'fixture-peer', 'pins.json');
		await mkdir(dirname(privatePins));
		await writeFile(privatePins, 'peer content must not be parsed');
		const refused = await invoke(['--pins-file', privatePins]);
		expect(refused.code).not.toBe(0);
		expect(refused.stderr).toContain('private storage');
		expect(refused.stderr).not.toContain('peer content must not be parsed');
	},
);

retentionTest('redirected mailbox is refused before reading a peer directory', async () => {
	const other = join(root, 'mailboxes', 'fixture-peer');
	await mkdir(other);
	await writeFile(join(other, 'secret.md'), 'peer bytes');
	const emptyOwn = resolve(root, 'mailboxes', owner);
	if (!emptyOwn.startsWith(resolve(root) + sep)) throw new Error('Wrong fixture root');
	await rm(emptyOwn, { recursive: true });
	await symlink(other, emptyOwn, process.platform === 'win32' ? 'junction' : 'dir');
	const run = await invoke();
	expect(run.code).not.toBe(0);
	expect(run.stderr).toContain('Retention path guard failed before access');
	expect(run.stdout).toBe('');
});

retentionTest('no operator, foreign-owner or apply path is exposed', async () => {
	for (const args of [
		['--owner', 'fixture-peer'],
		['--apply', 'yes'],
		['--cursor', '!bad'],
	])
		expect((await invoke(args)).code).not.toBe(0);
	expect((await invoke([], '')).code).not.toBe(0);
	const pins = join(root, 'pins.json');
	await writeFile(pins, JSON.stringify({ version: 1, owner: 'fixture-peer', sources: [] }));
	expect((await invoke(['--pins-file', pins])).stderr).toContain(
		'Pins belong to another mailbox owner',
	);
});

// Each Windows CLI launch gets its own default test budget instead of four sharing five seconds.
for (const provider of ['claude', 'codex', 'grok', 'kilo'])
	retentionTest(`${provider}: shared preview routes through its fixture identity`, async () => {
		const name = `fixture-${provider}`;
		const run = await invoke([], name);
		expect(run.code).toBe(0);
		expect(result(run.stdout).applyAvailable).toBe(false);
		expect(result(run.stdout).eligibleCount).toBe(0);
	});
