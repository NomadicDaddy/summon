import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWrite } from '../src/mail-files.ts';
import { loadAgent, newRecord, saveAgent } from '../src/store.ts';

test('atomic replacement remains complete while concurrent readers hold the file', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-atomic-'));
	const path = join(root, 'state.json');
	const padding = 'x'.repeat(10000);
	await atomicWrite(path, JSON.stringify({ sequence: 0, padding }));
	try {
		const reader = async () => {
			for (let index = 0; index < 80; index++) {
				const value = JSON.parse(await readFile(path, 'utf8')) as {
					sequence: number;
					padding: string;
				};
				expect(value.padding).toBe(padding);
				expect(Number.isSafeInteger(value.sequence)).toBe(true);
			}
		};
		await Promise.all([
			reader(),
			reader(),
			(async () => {
				for (let sequence = 1; sequence <= 40; sequence++) {
					await atomicWrite(path, JSON.stringify({ sequence, padding }));
				}
			})(),
		]);
		expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ sequence: 40, padding });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('agent record saves remain complete under concurrent readers', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-record-atomic-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		const record = newRecord('Writer', root, 'codex');
		record.expertise = 'x'.repeat(8000);
		await saveAgent('writer', record);
		const reader = async () => {
			for (let index = 0; index < 80; index++)
				expect((await loadAgent('writer'))?.expertise).toBe(record.expertise);
		};
		await Promise.all([
			reader(),
			reader(),
			(async () => {
				for (let index = 0; index < 40; index++) await saveAgent('writer', record);
			})(),
		]);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
});

if (process.platform === 'win32')
	test('atomic replacement waits for a temporary Windows reader denial', async () => {
		const root = await mkdtemp(join(tmpdir(), 'summon-rename-denial-'));
		const path = join(root, 'state.json');
		const ready = join(root, 'reader-ready');
		const script = join(root, 'hold-reader.ps1');
		await writeFile(path, 'old');
		await writeFile(
			script,
			'param($Path, $Ready)\n$file = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)\ntry { [System.IO.File]::WriteAllText($Ready, "ready"); Start-Sleep -Milliseconds 1250 } finally { $file.Dispose() }\n',
		);
		const holder = Bun.spawn(
			['pwsh', '-NoProfile', '-NonInteractive', '-File', script, path, ready],
			{ stdout: 'pipe', stderr: 'pipe' },
		);
		try {
			for (let attempt = 0; attempt < 250 && !(await Bun.file(ready).exists()); attempt++)
				await Bun.sleep(20);
			expect(await Bun.file(ready).exists()).toBe(true);
			await atomicWrite(path, 'new');
			expect(await readFile(path, 'utf8')).toBe('new');
		} finally {
			holder.kill();
			await holder.exited;
			await rm(root, { recursive: true, force: true });
		}
	}, 15000);
