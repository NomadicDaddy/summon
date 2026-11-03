import { Database } from 'bun:sqlite';
import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { checkClaim } from '../src/claims-checks.ts';
import { codexCompactionReader } from '../src/codex-compaction-history.ts';
import { readCompactions } from '../src/compaction-history.ts';
import { runtimePath } from '../src/mail-session.ts';
import { canonicalPath, redirectedComponent, sameRoot } from '../src/path-identity.ts';
import * as identity from '../src/path-identity.ts';
import { newRecord } from '../src/store.ts';

test('a root change is never a spelling alias', () => {
	expect(sameRoot('C:\\Work\\LONGNA~1\\x', 'C:\\Work\\Long name\\x', 'win32')).toBe(true);
	expect(sameRoot('c:\\work\\x', 'C:\\Work\\x', 'win32')).toBe(true);
	expect(sameRoot('S:\\work\\x', 'C:\\real\\work\\x', 'win32')).toBe(false);
	expect(sameRoot('Z:\\x', '\\\\server\\share\\x', 'win32')).toBe(false);
	expect(sameRoot('C:\\x', '\\\\?\\Volume{0}\\x', 'win32')).toBe(false);
	expect(sameRoot('/srv/a/x', '/srv/a/x', 'linux')).toBe(true);
});

// A real 8.3 alias needs Windows and a volume that generates short names. Where either is missing
// these controls are reported as skipped, never as passed.
let root: string | undefined;
let owner = '';
let ownerShort: string | undefined;
let credentialsShort: string | undefined;
let insideShort: string | undefined;
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
if (process.platform === 'win32') {
	root = await mkdtemp(join(tmpdir(), 'summon-retention-identity-'));
	owner = join(root, 'long owner directory');
	await mkdir(join(owner, 'credentials-folder'), { recursive: true });
	await mkdir(join(owner, 'inside target'));
	await mkdir(join(root, 'outside target'));
	await writeFile(join(owner, 'evidence.txt'), 'first\nexpected\n');
	await writeFile(join(owner, 'credentials-folder', 'note.txt'), 'expected\n');
	await writeFile(join(owner, 'inside target', 'inner.txt'), 'expected\n');
	await symlink(join(owner, 'inside target'), join(owner, 'inner alias'), 'junction');
	await symlink(join(root, 'outside target'), join(owner, 'escape'), 'junction');
	ownerShort = await shortAlias(owner);
	credentialsShort = await shortAlias(join(owner, 'credentials-folder'));
	insideShort = await shortAlias(join(owner, 'inside target'));
	if (!ownerShort || !credentialsShort || !insideShort)
		console.warn('Short-name identity controls skipped: the volume supplied no 8.3 alias.');
}
const unsupported =
	process.platform !== 'win32' || !ownerShort || !credentialsShort || !insideShort;
afterAll(async () => {
	if (!root) return;
	if (
		dirname(resolve(root)) !== resolve(tmpdir()) ||
		!basename(root).startsWith('summon-retention-identity-')
	)
		throw new Error('Wrong alias fixture root.');
	await rm(root, { recursive: true, force: true });
});
const claim = (check: unknown[], from: string) =>
	checkClaim({ id: 'test', text: 'published', check, duty: false }, from);

// Required on every Windows host: these need junctions, not 8.3 names.
test.skipIf(process.platform !== 'win32')(
	'claims refuse junctions, and refuse outside targets before probing them',
	async () => {
		if (!root) throw new Error('Missing fixture root.');
		for (const target of [join(owner, 'inner alias'), join(owner, 'escape', 'x.txt')])
			expect((await claim(['file-exists', target], owner)).state).toBe('UNVERIFIABLE');
		const probe = spyOn(identity, 'redirectedComponent');
		try {
			for (const target of [
				join(root, 'outside target'),
				join(owner, '..', 'outside target', 'x.txt'),
			])
				expect((await claim(['file-exists', target], owner)).state).toBe('UNVERIFIABLE');
			expect(probe).not.toHaveBeenCalled();
			// Positive control: an inside target is probed, so the spy is live.
			expect((await claim(['file-exists', join(owner, 'evidence.txt')], owner)).state).toBe(
				'WEAK',
			);
			expect(probe).toHaveBeenCalled();
		} finally {
			probe.mockRestore();
		}
	},
);

test.skipIf(unsupported)('a short-name alias is an identity, not a link', async () => {
	if (!ownerShort) throw new Error('Missing alias control.');
	expect(await redirectedComponent(join(ownerShort, 'evidence.txt'))).toBeUndefined();
	expect((await redirectedComponent(join(ownerShort, 'inner alias', 'x')))?.toLowerCase()).toBe(
		join(ownerShort, 'inner alias').toLowerCase(),
	);
	expect((await canonicalPath(join(ownerShort, 'missing', 'file.txt'))).toLowerCase()).toBe(
		join(await realpath(owner), 'missing', 'file.txt').toLowerCase(),
	);
});

// Accepted: a target under the root as configured, under its real spelling, or with shortened
// folders beneath either. Refused before any probe: a target under a separately shortened spelling
// of the root itself when the root is configured long, which is outside both recognised roots.
test.skipIf(unsupported)('claims accept an aliased owner root and target', async () => {
	if (!ownerShort || !insideShort) throw new Error('Missing alias control.');
	const target = join(ownerShort, 'evidence.txt');
	expect((await claim(['file-exists', target], ownerShort)).state).toBe('WEAK');
	expect(
		(await claim(['file-exists', join(await realpath(ownerShort), 'evidence.txt')], ownerShort))
			.state,
	).toBe('WEAK');
	const inner = join(owner, basename(insideShort), 'inner.txt');
	expect((await claim(['file-exists', inner], owner)).state).toBe('WEAK');
	expect((await claim(['file-contains', target, 'expected'], ownerShort)).state).toBe(
		'NOT-CONTRADICTED',
	);
	expect((await claim(['file-exists', join(ownerShort, 'absent.txt')], ownerShort)).state).toBe(
		'DISPUTED',
	);
});

test.skipIf(unsupported)(
	'claims refuse a separately shortened root spelling before probing it',
	async () => {
		if (!ownerShort) throw new Error('Missing alias control.');
		const probe = spyOn(identity, 'redirectedComponent');
		try {
			const target = join(ownerShort, 'evidence.txt');
			expect((await claim(['file-exists', target], owner)).state).toBe('UNVERIFIABLE');
			expect(probe).not.toHaveBeenCalled();
			// Positive control: the same target under the root as configured is probed.
			expect((await claim(['file-exists', target], ownerShort)).state).toBe('WEAK');
			expect(probe).toHaveBeenCalled();
		} finally {
			probe.mockRestore();
		}
	},
);

test.skipIf(unsupported)(
	'claims still refuse links and private names reached through an alias',
	async () => {
		if (!ownerShort || !credentialsShort) throw new Error('Missing alias control.');
		for (const target of [
			join(ownerShort, 'inner alias'),
			join(ownerShort, 'escape', 'x.txt'),
			join(ownerShort, '..', 'outside target'),
		])
			expect((await claim(['file-exists', target], ownerShort)).state).toBe('UNVERIFIABLE');
		// The long owner path with only the private folder shortened stays lexically inside the root
		// and no longer contains the private word; the folder's identity still names it.
		const hidden = join(owner, basename(credentialsShort), 'note.txt');
		expect((await claim(['file-contains', hidden, 'expected'], owner)).state).toBe(
			'UNVERIFIABLE',
		);
	},
);

const oldHome = process.env.SUMMON_HOME;
const oldCodex = process.env.CODEX_HOME;
afterEach(() => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	if (oldCodex === undefined) delete process.env.CODEX_HOME;
	else process.env.CODEX_HOME = oldCodex;
});
async function codexFixture(label: string, record: (rollout: string) => Promise<string>) {
	if (!root) throw new Error('Missing alias control.');
	const store = join(root, `${label} store`);
	const home = join(root, `${label} codex home`);
	await mkdir(join(home, 'sessions', 'real sessions folder'), { recursive: true });
	await mkdir(store);
	await writeFile(join(store, 'alpha.json'), JSON.stringify(newRecord('alpha', root, 'codex')));
	process.env.SUMMON_HOME = store;
	process.env.CODEX_HOME = home;
	const rollout = join(home, 'sessions', 'real sessions folder', 'synthetic rollout.jsonl');
	const thread = `synthetic-${label}`;
	await writeFile(
		rollout,
		JSON.stringify({ type: 'session_meta', payload: { id: thread } }) + '\n',
	);
	const database = new Database(join(home, 'state_5.sqlite'));
	try {
		database.run('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT)');
		database
			.query('INSERT INTO threads VALUES (?, ?, ?)')
			.run(thread, await record(rollout), '');
	} finally {
		database.close();
	}
	await mkdir(runtimePath('alpha'), { recursive: true });
	await writeFile(join(runtimePath('alpha'), `${label}.binding`), thread);
	await appendFile(
		rollout,
		JSON.stringify({
			timestamp: '2026-01-01T00:00:00.000Z',
			type: 'compacted',
			payload: { window_id: `${label}-window`, compaction_response_id: `${label}-response` },
		}) + '\n',
	);
	const scan = codexCompactionReader('alpha', label);
	await scan();
	await scan();
	return (await readCompactions('alpha', 10)).retainedObservations;
}

test.skipIf(unsupported)(
	'a Codex rollout recorded under a short-name alias is retained',
	async () => {
		const retained = await codexFixture('aliased', async (rollout) => {
			const alias = await shortAlias(rollout);
			if (!alias) throw new Error('Missing alias control.');
			return alias;
		});
		expect(retained).toBe(1);
	},
);

test.skipIf(unsupported)(
	'a Codex rollout recorded through a junction is still refused',
	async () => {
		const retained = await codexFixture('junctioned', async (rollout) => {
			const sessions = dirname(dirname(rollout));
			await symlink(
				join(sessions, 'real sessions folder'),
				join(sessions, 'linked'),
				'junction',
			);
			const alias = await shortAlias(join(sessions, 'linked', basename(rollout)));
			if (!alias) throw new Error('Missing alias control.');
			return alias;
		});
		expect(retained).toBe(0);
	},
);
