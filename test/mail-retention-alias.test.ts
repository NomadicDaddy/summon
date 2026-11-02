import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { withRetentionPaths } from '../src/mail-retention-access.ts';

let root: string | undefined;
let privatePins: string | undefined;
let shortPath: string | undefined;
if (process.platform === 'win32') {
	root = await mkdtemp(join(tmpdir(), 'summon-retention-alias-'));
	await mkdir(join(root, 'mailboxes', 'fixture-codex', 'inbox'), { recursive: true });
	const peer = join(root, 'mailboxes', 'fixture-peer-long-registration');
	await mkdir(peer);
	privatePins = join(peer, 'private-pins.json');
	await writeFile(privatePins, 'private fixture pin bytes must never be parsed');
	const child = Bun.spawn(
		[
			'pwsh',
			'-NoProfile',
			'-NonInteractive',
			'-File',
			join(import.meta.dir, 'fixtures/retention-path-probe.ps1'),
			'-Mode',
			'short',
			'-TestRoot',
			root,
			'-Path',
			privatePins,
		],
		{ stdout: 'pipe', stderr: 'pipe', windowsHide: true },
	);
	const [output, error, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`Alias fixture probe failed: ${error}`);
	const value = JSON.parse(output) as { path: string };
	if (value.path.toLowerCase() !== privatePins.toLowerCase()) shortPath = value.path;
	else
		console.warn(
			'Retention alias control skipped: fixture volume supplied no distinct 8.3 alias.',
		);
}
afterAll(async () => {
	if (!root) return;
	if (
		dirname(resolve(root)) !== resolve(tmpdir()) ||
		!basename(root).startsWith('summon-retention-alias-')
	)
		throw new Error('Wrong alias fixture root.');
	await rm(root, { recursive: true, force: true });
});
test.skipIf(process.platform !== 'win32' || !shortPath)(
	'real Windows short-name alias identifies peer fixture but CLI refuses before pin parsing',
	async () => {
		if (!root || !privatePins || !shortPath)
			throw new Error('Missing supported alias control.');
		const [longInfo, shortInfo] = await Promise.all([stat(privatePins), stat(shortPath)]);
		expect(shortInfo.ino).toBe(longInfo.ino);
		expect(shortInfo.dev).toBe(longInfo.dev);
		expect(await readFile(shortPath, 'utf8')).toBe(
			'private fixture pin bytes must never be parsed',
		);
		const own = join(root, 'mailboxes', 'fixture-codex');
		// The fixture root may itself be a short-form TEMP; the canonical identity is the real path.
		const expectedCanonical = (await realpath(privatePins)).toLowerCase();
		await withRetentionPaths(
			[
				own,
				join(own, 'inbox'),
				join(own, 'archive'),
				join(own, 'delivery'),
				join(own, 'holds'),
				shortPath,
			],
			(present, _observe, canonical) => {
				expect(present[5]).toBe(true);
				expect(canonical[5]?.toLowerCase()).toBe(expectedCanonical);
				return Promise.resolve();
			},
		);
		const child = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, '../src/cli.ts'),
				'--mail-retention',
				'preview',
				'--pins-file',
				shortPath,
			],
			{
				env: {
					...process.env,
					SUMMON_HOME: root,
					SUMMON_AGENT: 'fixture-codex',
					SUMMON_NONCE: 'fixture-launch',
				},
				stdout: 'pipe',
				stderr: 'pipe',
				windowsHide: true,
			},
		);
		const [output, error, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code).not.toBe(0);
		expect(output).toBe('');
		expect(error).toContain('private storage');
		expect(error).not.toContain('private fixture pin bytes');
	},
);
