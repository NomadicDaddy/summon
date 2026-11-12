import { afterAll, expect, spyOn, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { mkdir, mkdtemp, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { maintenanceHost } from '../src/maintenance-host.ts';
import * as identity from '../src/path-identity.ts';
import { newRecord } from '../src/store.ts';

// Claims storage and the standing updater's checkout, addressed through a spelling alias. The 8.3
// controls need a volume that generates short names and are skipped otherwise, never passed. The
// letter-case control needs only Windows.
let root: string | undefined;
async function shortAlias(path: string): Promise<string | undefined> {
	if (!root) return undefined;
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
			path,
		],
		{ stdout: 'pipe', stderr: 'pipe', windowsHide: true },
	);
	const [output, error, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`Alias fixture probe failed: ${error}`);
	const value = (JSON.parse(output) as { path: string }).path;
	return value.toLowerCase() === path.toLowerCase() ? undefined : value;
}
let store = '';
let storeShort: string | undefined;
if (process.platform === 'win32') {
	root = await mkdtemp(join(tmpdir(), 'summon-retention-store-'));
	store = join(root, 'long claims store');
	await mkdir(join(store, 'claims'), { recursive: true });
	await writeFile(join(store, 'alpha.json'), JSON.stringify(newRecord('alpha', root, 'claude')));
	await mkdir(join(store, 'runtime/alpha'), { recursive: true });
	await writeFile(
		join(store, 'runtime/alpha/activity.json'),
		JSON.stringify({
			workingOn: '',
			state: 'idle',
			updatedAt: new Date().toISOString(),
			nonce: 'test',
		}),
	);
	await writeFile(join(root, 'evidence.txt'), 'expected\n');
	await writeFile(
		join(store, 'claims', 'alpha.md'),
		`- FACT Evidence published | verify: ["file-exists", ${JSON.stringify(join(root, 'evidence.txt'))}]`,
	);
	storeShort = await shortAlias(store);
	if (!storeShort)
		console.warn('Short-name store controls skipped: the volume supplied no 8.3 alias.');
}
afterAll(async () => {
	if (!root) return;
	if (
		dirname(resolve(root)) !== resolve(tmpdir()) ||
		!basename(root).startsWith('summon-retention-store-')
	)
		throw new Error('Wrong alias fixture root.');
	await rm(root, { recursive: true, force: true });
});
async function verify(home: string) {
	if (!root) throw new Error('Missing fixture root.');
	const child = Bun.spawn(
		[process.execPath, join(import.meta.dir, '../src/cli.ts'), '--verify-claims'],
		{
			cwd: root,
			env: { ...process.env, SUMMON_HOME: home, SUMMON_AGENT: 'alpha', SUMMON_NONCE: 'test' },
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		},
	);
	const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	return { out, code };
}

test.skipIf(process.platform !== 'win32' || !storeShort)(
	'claims read a store addressed through a short-name alias',
	async () => {
		if (!storeShort) throw new Error('Missing alias control.');
		const result = await verify(storeShort);
		expect(result.code).toBe(0);
		expect((JSON.parse(result.out) as { results: { state: string }[] }).results[0]?.state).toBe(
			'WEAK',
		);
	},
);

test.skipIf(process.platform !== 'win32' || !storeShort)(
	'claims still refuse a store whose claims folder is a junction',
	async () => {
		if (!root || !storeShort) throw new Error('Missing alias control.');
		const linked = join(root, 'linked claims store');
		await mkdir(linked);
		await writeFile(
			join(linked, 'alpha.json'),
			JSON.stringify(newRecord('alpha', root, 'claude')),
		);
		await symlink(join(store, 'claims'), join(linked, 'claims'), 'junction');
		const aliased = await shortAlias(linked);
		if (!aliased) throw new Error('Missing alias control.');
		expect((await verify(aliased)).code).not.toBe(0);
	},
);

async function checkout(label: string, spell: (repo: string) => Promise<string | undefined>) {
	if (!root) throw new Error('Missing fixture root.');
	const base = join(root, `${label} updater`);
	const repo = join(base, 'fixture checkout');
	const command = join(base, 'standing');
	await mkdir(repo, { recursive: true });
	await mkdir(command);
	const git = (...args: string[]) => {
		const child = Bun.spawnSync(['git', '-C', repo, ...args], { windowsHide: true });
		if (child.exitCode !== 0) throw new Error(child.stderr.toString());
	};
	git('init', '-b', 'main');
	git('config', 'user.name', 'Identity fixture');
	git('config', 'user.email', 'fixture@example.invalid');
	git('config', 'commit.gpgsign', 'false');
	git('config', 'core.hooksPath', join(base, 'empty-hooks'));
	await writeFile(join(repo, 'version.txt'), 'first');
	git('add', '.');
	git('commit', '-m', 'fixture');
	const spelled = await spell(repo);
	if (!spelled) return undefined;
	const link = join(base, 'installed');
	await symlink(repo, link, 'junction');
	const config = { version: 1, repo: spelled, home: join(base, 'home'), link };
	await writeFile(join(command, 'config.json'), JSON.stringify(config));
	return { host: await maintenanceHost(command, join(command, 'logs')), base, repo, command };
}

test.skipIf(process.platform !== 'win32')(
	'the updater accepts its checkout spelled in another letter case',
	async () => {
		const fixture = await checkout('cased', (repo) => Promise.resolve(repo.toUpperCase()));
		if (!fixture) throw new Error('Missing fixture.');
		await fixture.host.preflight();
	},
);

// No drive mapping is created: the root comparison is forced to report a shift, which proves the
// updater consults it and refuses. Real subst and mapped-drive behaviour stays unmeasured.
test.skipIf(process.platform !== 'win32')(
	'the updater refuses a configured checkout whose real path is on another root',
	async () => {
		const fixture = await checkout('shifted', (repo) => Promise.resolve(repo));
		if (!fixture) throw new Error('Missing fixture.');
		await fixture.host.preflight(); // positive control: the same checkout passes unforced
		const shifted = spyOn(identity, 'sameRoot').mockReturnValue(false);
		try {
			await rejects(fixture.host.preflight(), /Checkout root or clean boundary differs/);
			expect(shifted).toHaveBeenCalled();
		} finally {
			shifted.mockRestore();
		}
	},
);

test.skipIf(process.platform !== 'win32' || !storeShort)(
	'the updater accepts a short-name alias of its checkout but not a link to another one',
	async () => {
		const fixture = await checkout('aliased', shortAlias);
		if (!fixture) throw new Error('Missing alias control.');
		await fixture.host.preflight();
		const other = join(fixture.base, 'other checkout');
		await mkdir(other);
		await rmdir(join(fixture.base, 'installed')); // removes the junction only, not its target
		await symlink(other, join(fixture.base, 'installed'), 'junction');
		await rejects(fixture.host.preflight(), /does not target this checkout/);
	},
);
