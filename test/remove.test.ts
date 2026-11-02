import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { newRecord } from '../src/store.ts';

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-remove-'));
	await writeFile(
		join(root, 'test-agent.json'),
		JSON.stringify(newRecord('test-agent', root, 'claude')),
	);
});
afterEach(async () => {
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('summon-remove-'))
		throw new Error('Unexpected test directory.');
	await rm(root, { recursive: true, force: true, maxRetries: 3 });
});
async function invoke(args: string[], agent = '') {
	const child = Bun.spawn({
		cmd: [process.execPath, resolve('src/cli.ts'), ...args],
		env: { ...process.env, SUMMON_HOME: root, SUMMON_AGENT: agent },
		stdout: 'pipe',
		stderr: 'pipe',
		stdin: 'ignore',
	});
	return {
		code: await child.exited,
		out: await new Response(child.stdout).text(),
		err: await new Response(child.stderr).text(),
	};
}
test('remove cleans only the selected agent and updates the roster', async () => {
	await writeFile(
		join(root, 'neighbor.json'),
		JSON.stringify(newRecord('neighbor', root, 'codex')),
	);
	await writeFile(join(root, 'test-agent.md'), 'notes');
	await writeFile(join(root, 'test-agent.png'), 'own icon');
	await writeFile(join(root, 'neighbor.png'), 'keep icon');
	for (const folder of ['inbox', 'archive']) {
		await mkdir(join(root, 'mailboxes', 'neighbor', folder), { recursive: true });
		await writeFile(
			join(root, 'mailboxes', 'neighbor', folder, 'from-test-agent.md'),
			'From: test-agent\nKeep this message.',
		);
	}
	for (const area of ['mailboxes', 'runtime']) {
		await mkdir(join(root, area, 'test-agent'), { recursive: true });
		await writeFile(join(root, area, 'test-agent', 'data'), 'data');
	}
	await mkdir(join(root, 'attention'));
	await mkdir(join(root, 'runtime', 'test-agent', 'session-stale-old'));
	await writeFile(join(root, 'runtime', 'test-agent', 'session-stale-old', 'owner.json'), '{}');
	await mkdir(join(root, 'runtime', 'neighbor'));
	await writeFile(join(root, 'runtime', 'neighbor', 'data'), 'keep runtime');
	await writeFile(join(root, 'attention', 'own.ref'), 'test-agent');
	await writeFile(join(root, 'attention', 'other.ref'), 'neighbor');
	const result = await invoke(['--remove', 'TEST-AGENT']);
	expect(result.code).toBe(0);
	expect(result.out).toContain('Removed TEST-AGENT');
	expect(await Bun.file(join(root, 'test-agent.json')).exists()).toBe(false);
	expect(await Bun.file(join(root, 'test-agent.md')).exists()).toBe(false);
	expect(await Bun.file(join(root, 'test-agent.png')).exists()).toBe(false);
	expect(await readFile(join(root, 'neighbor.png'), 'utf8')).toBe('keep icon');
	expect(await readdir(join(root, 'runtime'))).toEqual(['neighbor']);
	expect(await readFile(join(root, 'runtime', 'neighbor', 'data'), 'utf8')).toBe('keep runtime');
	expect(await readdir(join(root, 'mailboxes'))).toEqual(['neighbor']);
	for (const folder of ['inbox', 'archive'])
		expect(
			await readFile(
				join(root, 'mailboxes', 'neighbor', folder, 'from-test-agent.md'),
				'utf8',
			),
		).toBe('From: test-agent\nKeep this message.');
	expect(await readdir(join(root, 'attention'))).toEqual(['other.ref']);
	expect(await Bun.file(join(root, 'AGENTS.md')).exists()).toBe(true);
	expect((await invoke(['list'])).out).toContain('neighbor');
	expect((await invoke(['list'])).out).not.toContain('test-agent');
});
test('running agent is preserved', async () => {
	const lock = join(root, 'runtime', 'test-agent', 'session.lock');
	await mkdir(lock, { recursive: true });
	await writeFile(
		join(lock, 'owner.json'),
		JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() }),
	);
	const before = await readFile(join(root, 'test-agent.json'), 'utf8');
	const result = await invoke(['--remove', 'test-agent']);
	expect(result.code).toBe(1);
	expect(result.err).toContain('is running');
	expect(await readFile(join(root, 'test-agent.json'), 'utf8')).toBe(before);
});
test('invalid arguments, unknown names and agent callers cannot remove records', async () => {
	for (const args of [
		['--remove'],
		['--remove', '../test-agent'],
		['--remove', 'test-agent', '--same-window'],
		['--remove', 'missing'],
	])
		expect((await invoke(args)).code).toBe(1);
	expect((await invoke(['--remove', 'test-agent'], 'neighbor')).code).toBe(1);
	expect(await Bun.file(join(root, 'test-agent.json')).exists()).toBe(true);
});
test('redirected storage is rejected before deleting the registration', async () => {
	await mkdir(join(root, 'outside'));
	await symlink(join(root, 'outside'), join(root, 'mailboxes'), 'junction');
	expect((await invoke(['--remove', 'test-agent'])).code).toBe(1);
	expect(await Bun.file(join(root, 'test-agent.json')).exists()).toBe(true);
});

/** Phillip #17710: Delete removes the member's own scratch folders and nobody else's. */
async function scratchFixture(slug = 'test-agent') {
	for (const path of [
		['scratch', slug],
		['scratch', 'shared', slug],
		['scratch', 'neighbor'],
		['scratch', 'shared', 'neighbor'],
	]) {
		await mkdir(join(root, ...path, 'deep'), { recursive: true });
		await writeFile(join(root, ...path, 'deep', 'file.txt'), path.join('/'));
	}
	await writeFile(join(root, 'scratch', 'shared', 'handoff.md'), 'team file');
}
test('delete removes the member scratch folders and keeps everyone else', async () => {
	await scratchFixture();
	const result = await invoke(['--remove', 'test-agent']);
	expect(result.code).toBe(0);
	expect(await readdir(join(root, 'scratch')).then((names) => names.sort())).toEqual([
		'neighbor',
		'shared',
	]);
	expect((await readdir(join(root, 'scratch', 'shared'))).sort()).toEqual([
		'handoff.md',
		'neighbor',
	]);
	expect(await readFile(join(root, 'scratch', 'neighbor', 'deep', 'file.txt'), 'utf8')).toBe(
		'scratch/neighbor',
	);
});
test('absent scratch folders are harmless', async () => {
	expect((await invoke(['--remove', 'test-agent'])).code).toBe(0);
	expect(await Bun.file(join(root, 'test-agent.json')).exists()).toBe(false);
});
test('a member named shared never takes the shared scratch root', async () => {
	await writeFile(join(root, 'shared.json'), JSON.stringify(newRecord('shared', root, 'claude')));
	// This member's fixture "personal" folder is scratch/shared itself: its deep/ is team content.
	await scratchFixture('shared');
	expect((await invoke(['--remove', 'shared'])).code).toBe(0);
	expect((await readdir(join(root, 'scratch', 'shared'))).sort()).toEqual([
		'deep',
		'handoff.md',
		'neighbor',
	]);
});
test('a redirected scratch folder is refused before anything is deleted', async () => {
	await mkdir(join(root, 'outside'));
	await writeFile(join(root, 'outside', 'keep.txt'), 'outside');
	await mkdir(join(root, 'scratch', 'shared'), { recursive: true });
	await symlink(join(root, 'outside'), join(root, 'scratch', 'shared', 'test-agent'), 'junction');
	const result = await invoke(['--remove', 'test-agent']);
	expect(result.code).toBe(1);
	expect(result.err).toContain('redirected');
	expect(await Bun.file(join(root, 'test-agent.json')).exists()).toBe(true);
	expect(await readFile(join(root, 'outside', 'keep.txt'), 'utf8')).toBe('outside');
});
// Windows refuses to delete a folder that a running process holds as its working directory.
test.skipIf(process.platform !== 'win32')(
	'a scratch removal that fails keeps the registration, names what went, and a retry succeeds',
	async () => {
		await scratchFixture();
		const holder = Bun.spawn({
			cmd: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
			cwd: join(root, 'scratch', 'shared', 'test-agent', 'deep'),
			stdout: 'ignore',
			stderr: 'ignore',
		});
		try {
			const failed = await invoke(['--remove', 'test-agent']);
			expect(failed.code).toBe(1);
			expect(failed.err).toContain('still registered');
			// Messages name the store's real path; a short-form TEMP root spells it differently.
			expect(failed.err).toContain(
				`Already removed: ${join(await realpath(root), 'scratch', 'test-agent')}.`,
			);
			expect(await readdir(join(root, 'scratch'))).toEqual(['neighbor', 'shared']);
			expect(await Bun.file(join(root, 'test-agent.json')).exists()).toBe(true);
		} finally {
			holder.kill();
			await holder.exited;
		}
		expect((await invoke(['--remove', 'test-agent'])).code).toBe(0);
		expect(await Bun.file(join(root, 'test-agent.json')).exists()).toBe(false);
		expect(await readdir(join(root, 'scratch'))).toEqual(['neighbor', 'shared']);
	},
);
