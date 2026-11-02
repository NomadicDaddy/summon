import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { boardDocumentSchema } from '../src/board-model.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

test('Board CLI preserves serialized Windows paths through create, update and history', async () => {
	const h = await mailHarness();
	try {
		const paths = String.raw`D:\applications\deeper.project
C:\new\test\backups\
\\server\share\folder with spaces\report.txt
Quotes "stay", apostrophe ' stays, $HOME and $(whoami) stay literal.`;
		const created = await h.run([
			'--board',
			'create',
			JSON.stringify({ title: 'Path round-trip', description: paths, evidence: [paths] }),
		]);
		expect(created.code).toBe(0);
		const first = boardDocumentSchema.parse(JSON.parse(await h.read('board/state.json')));
		const item = first.items[0];
		if (!item) throw new Error('Expected created card');
		expect(item.description).toBe(paths);
		expect(item.evidence).toEqual([paths]);
		const updated = await h.run([
			'--board',
			'update',
			item.id,
			String(item.revision),
			JSON.stringify({
				description: `${paths}\nUpdated`,
				project: String.raw`D:\applications`,
			}),
		]);
		expect(updated.code).toBe(0);
		const saved = boardDocumentSchema.parse(JSON.parse(await h.read('board/state.json')));
		expect(saved.items[0]?.description).toBe(`${paths}\nUpdated`);
		expect(saved.items[0]?.project).toBe(String.raw`D:\applications`);
		expect(saved.history.at(-1)?.before?.description).toBe(paths);
		expect(saved.history.at(-1)?.after.description).toBe(`${paths}\nUpdated`);
	} finally {
		await h.dispose();
	}
}, 15_000); // Two CLI processes and cleanup; keep a bounded allowance for Windows startup.

test('Board CLI rejects unescaped invalid JSON rather than repairing or losing path separators', async () => {
	const h = await mailHarness();
	try {
		const result = await h.run([
			'--board',
			'create',
			String.raw`{"title":"Bad path","description":"D:\applications\deeper.project"}`,
		]);
		expect(result.code).not.toBe(0);
		expect(await h.read('board/state.json').catch(() => '')).toBe('');
	} finally {
		await h.dispose();
	}
});

test.skipIf(process.platform !== 'win32')(
	'PowerShell serialized Board input preserves literal paths',
	async () => {
		const h = await mailHarness();
		try {
			const path = String.raw`D:\applications\new\test folder\deeper.project`;
			const script = join(h.root, 'board-input.ps1');
			const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
			await writeFile(
				script,
				`$body = @{ title = 'PowerShell path'; description = ${quote(path)} } | ConvertTo-Json -Compress
& ${quote(process.execPath)} ${quote(join(import.meta.dir, '../src/cli.ts'))} --board create $body
exit $LASTEXITCODE
`,
			);
			const child = Bun.spawn(['pwsh', '-NoProfile', '-NonInteractive', '-File', script], {
				env: { ...process.env, SUMMON_HOME: h.records },
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				windowsHide: true,
			});
			const [code, output, error] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect({ code, error }).toEqual({ code: 0, error: '' });
			expect(output).toContain('PowerShell path');
			const saved = boardDocumentSchema.parse(JSON.parse(await h.read('board/state.json')));
			expect(saved.items[0]?.description).toBe(path);
		} finally {
			await h.dispose();
		}
	},
);
