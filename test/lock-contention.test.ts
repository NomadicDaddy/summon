import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('eight processes retain every locked update across 320 contending operations', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-lock-contention-'));
	const path = join(root, 'counter.txt');
	const children: Bun.Subprocess<'ignore', 'ignore', 'pipe'>[] = [];
	try {
		await writeFile(path, '0');
		for (let index = 0; index < 8; index++)
			children.push(
				Bun.spawn(
					[
						process.execPath,
						join(import.meta.dir, 'fixtures/lock-counter.ts'),
						path,
						'40',
					],
					{
						stdin: 'ignore',
						stdout: 'ignore',
						stderr: 'pipe',
						windowsHide: true,
					},
				),
			);
		const results = await Promise.all(
			children.map(async (child) => ({
				code: await child.exited,
				error: await new Response(child.stderr).text(),
			})),
		);
		for (const result of results) expect(result).toEqual({ code: 0, error: '' });
		expect(await readFile(path, 'utf8')).toBe('320');
	} finally {
		for (const child of children) if (child.exitCode === null) child.kill();
		await Promise.all(children.map((child) => child.exited));
		await rm(root, { recursive: true, force: true });
	}
}, 20000);
