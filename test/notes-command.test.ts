import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { newRecord } from '../src/store.ts';

const before = process.env.SUMMON_HOME;
let root: string | undefined;
afterEach(async () => {
	if (before === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = before;
	if (root) await rm(root, { recursive: true, force: true });
});

test('named notes edits preserve peers and reject stale, redirected and delete requests', async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-notes-'));
	process.env.SUMMON_HOME = root;
	await writeFile(join(root, 'alpha.json'), JSON.stringify(newRecord('alpha', root, 'codex')));
	await writeFile(join(root, 'alpha.md'), 'old notes');
	await writeFile(join(root, 'beta.md'), 'peer notes');
	await initializeActivity('alpha', 'fixture-nonce');
	const request = async (args: string[], input = '', nonce = 'fixture-nonce') => {
		const child = Bun.spawn([process.execPath, resolve('src/cli.ts'), '--notes', ...args], {
			env: { ...process.env, SUMMON_AGENT: 'alpha', SUMMON_NONCE: nonce },
			stdin: new Blob([input]),
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [code, out, error] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { code, out, error };
	};
	const original = await request(['read']);
	expect(original.code).toBe(0);
	const oldRevision = createHash('sha256').update('old notes').digest('hex');
	expect(JSON.parse(original.out)).toEqual({ revision: oldRevision, text: 'old notes' });
	const edit = JSON.stringify({ revision: oldRevision, text: 'reconciled notes\n✓' });
	expect((await request(['write'], edit)).code).toBe(0);
	expect(await readFile(join(root, 'alpha.md'), 'utf8')).toBe('reconciled notes\n✓');
	expect(await readFile(join(root, 'beta.md'), 'utf8')).toBe('peer notes');
	const currentRevision = createHash('sha256').update('reconciled notes\n✓').digest('hex');
	const exact = '😀'.repeat(4096);
	expect(
		(await request(['write'], JSON.stringify({ revision: currentRevision, text: exact }))).code,
	).toBe(0);
	const exactRevision = createHash('sha256').update(exact).digest('hex');
	expect(
		(await request(['write'], JSON.stringify({ revision: exactRevision, text: exact + 'x' })))
			.error,
	).toContain('16 KiB');
	expect(await readFile(join(root, 'alpha.md'), 'utf8')).toBe(exact);
	// Existing oversized notes stay readable for preservation and a revision-checked compact edit.
	const oversized = 'x'.repeat(20_000);
	await writeFile(join(root, 'alpha.md'), oversized);
	const large = await request(['read']);
	expect(JSON.parse(large.out) as unknown).toEqual({
		revision: createHash('sha256').update(oversized).digest('hex'),
		text: oversized,
	});
	expect(
		(
			await request(
				['write'],
				JSON.stringify({
					revision: createHash('sha256').update(oversized).digest('hex'),
					text: 'Compacted active notes',
				}),
			)
		).code,
	).toBe(0);
	expect((await request(['write'], edit)).error).toContain('changed since read');
	expect((await request(['delete'])).code).toBe(1);
	expect((await request(['write', 'beta'], edit)).code).toBe(1);
	expect(
		(
			await request(
				['write'],
				JSON.stringify({ revision: oldRevision, text: '', name: 'beta' }),
			)
		).code,
	).toBe(1);
	expect((await request(['read'], '', 'stale-nonce')).error).toContain(
		'current registered launch',
	);
	await rm(join(root, 'alpha.md'));
	expect(
		(
			await request(
				['write'],
				JSON.stringify({
					revision: createHash('sha256').update('').digest('hex'),
					text: 'new',
				}),
			)
		).code,
	).toBe(0);
	expect(await readFile(join(root, 'alpha.md'), 'utf8')).toBe('new');
	await rm(join(root, 'alpha.md'));
	await symlink(join(root, 'beta.md'), join(root, 'alpha.md'));
	expect((await request(['read'])).code).toBe(1);
	expect(await readFile(join(root, 'beta.md'), 'utf8')).toBe('peer notes');
}, 20_000);
