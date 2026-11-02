import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('runner isolates file hooks and never restores the invoking team store', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-runner-control-'));
	try {
		const protectedFile = join(root, 'sentinel.txt');
		await writeFile(protectedFile, 'unchanged');
		const first = join(root, 'first.test.ts');
		const second = join(root, 'second.test.ts');
		const evidence = join(root, 'evidence.json');
		await writeFile(
			first,
			`import { beforeEach, test, expect } from 'bun:test';
beforeEach(() => { globalThis.fixtureHook = 'first-file'; });
test('positive hook control', () => expect(globalThis.fixtureHook).toBe('first-file'));`,
		);
		await writeFile(
			second,
			`import { test, expect } from 'bun:test';
test('isolated sibling', async () => {
 expect(globalThis.fixtureHook).toBeUndefined();
 expect(process.env.SUMMON_HOME).not.toBe(${JSON.stringify(root)});
 expect(process.env.SUMMON_AGENT).toBeUndefined();
 expect(process.env.SUMMON_NONCE).toBeUndefined();
 await Bun.write(${JSON.stringify(evidence)}, JSON.stringify({ home: process.env.SUMMON_HOME }));
 await Bun.write(process.env.SUMMON_HOME + '/sentinel.txt', 'disposable write');
});`,
		);
		const child = Bun.spawn(
			[process.execPath, join(import.meta.dir, '../scripts/test.ts'), first, second],
			{
				env: {
					...process.env,
					SUMMON_HOME: root,
					SUMMON_AGENT: 'fixture',
					SUMMON_NONCE: 'fixture',
				},
				stdout: 'pipe',
				stderr: 'pipe',
				windowsHide: true,
			},
		);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ code, output: code === 0 ? '' : stdout + stderr }).toEqual({
			code: 0,
			output: '',
		});
		expect(await readFile(protectedFile, 'utf8')).toBe('unchanged');
		const saved: unknown = JSON.parse(await readFile(evidence, 'utf8'));
		if (
			!saved ||
			typeof saved !== 'object' ||
			!('home' in saved) ||
			typeof saved.home !== 'string'
		)
			throw new Error('Missing runner root evidence.');
		expect(await Bun.file(join(saved.home, 'sentinel.txt')).exists()).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
