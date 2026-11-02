import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { newRecord, providers } from '../src/store.ts';

const before = process.env.SUMMON_HOME;
let root: string | undefined;
const revision = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(async () => {
	if (before === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = before;
	if (root) await rm(root, { recursive: true, force: true });
});

async function request(
	home: string,
	action: string,
	text = '',
	rev = revision(''),
	nonce = 'current',
	name = 'alpha',
) {
	const child = Bun.spawn([process.execPath, resolve('src/cli.ts'), '--notes', action], {
		env: { ...process.env, SUMMON_HOME: home, SUMMON_AGENT: name, SUMMON_NONCE: nonce },
		stdin: new Blob([JSON.stringify({ revision: rev, text })]),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [code, out, error] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, out, error };
}

for (const provider of providers) {
	test(`${provider} current launch creates own notes with serialized revisions`, async () => {
		root = await mkdtemp(join(tmpdir(), 'summon-notes-create-'));
		process.env.SUMMON_HOME = root;
		await writeFile(
			join(root, 'alpha.json'),
			JSON.stringify(newRecord('alpha', root, provider)),
		);
		await writeFile(join(root, 'beta.md'), 'peer unchanged');
		await initializeActivity('alpha', 'current');
		const empty = await request(root, 'read');
		expect(empty.code).toBe(0);
		expect(JSON.parse(empty.out) as unknown).toEqual({ revision: revision(''), text: '' });
		expect((await request(root, 'write', 'stale', revision('old'))).error).toContain(
			'changed since read',
		);
		expect((await request(root, 'write', 'stale', revision(''), 'expired')).code).toBe(1);
		expect(
			(await request(root, 'write', 'foreign', revision(''), 'current', 'beta')).code,
		).toBe(1);
		expect((await request(root, 'write', 'large'.repeat(5000))).error).toContain('16 KiB');
		expect(await Bun.file(join(root, 'alpha.md')).exists()).toBe(false);
		const attempts = await Promise.all([
			request(root, 'write', 'first ✓'),
			request(root, 'write', 'second ✓'),
		]);
		expect(attempts.map((result) => result.code).sort()).toEqual([0, 1]);
		expect(attempts.find((result) => result.code === 1)?.error).toContain('changed since read');
		const saved = await readFile(join(root, 'alpha.md'), 'utf8');
		expect(['first ✓', 'second ✓']).toContain(saved);
		const reread = await request(root, 'read');
		expect(JSON.parse(reread.out) as unknown).toEqual({
			revision: revision(saved),
			text: saved,
		});
		expect((await request(root, 'write', 'updated', revision(saved))).code).toBe(0);
		expect(await readFile(join(root, 'alpha.md'), 'utf8')).toBe('updated');
		expect(await readFile(join(root, 'beta.md'), 'utf8')).toBe('peer unchanged');
	}, 20_000);
}

test('missing-notes creation refuses redirected storage and nonregular targets', async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-notes-safety-'));
	const home = join(root, 'home');
	await mkdir(home);
	process.env.SUMMON_HOME = home;
	await writeFile(join(home, 'alpha.json'), JSON.stringify(newRecord('alpha', home, 'codex')));
	await initializeActivity('alpha', 'current');
	const redirected = join(root, 'redirected');
	await symlink(home, redirected, 'junction');
	expect((await request(redirected, 'write', 'blocked')).error).toContain(
		'storage must use real directories',
	);
	expect(await Bun.file(join(home, 'alpha.md')).exists()).toBe(false);
	const target = join(home, 'alpha.md');
	await mkdir(target);
	expect((await request(home, 'write', 'blocked')).error).toContain('regular file');
	await rm(target, { recursive: true });
	const peer = join(home, 'beta.md');
	await writeFile(peer, 'peer');
	await link(peer, target);
	expect((await request(home, 'write', 'blocked', revision('peer'))).error).toContain(
		'regular file',
	);
	await rm(target);
	await symlink(peer, target);
	expect((await request(home, 'write', 'blocked', revision('peer'))).error).toContain(
		'regular file',
	);
	expect(await readFile(peer, 'utf8')).toBe('peer');
}, 20_000);
