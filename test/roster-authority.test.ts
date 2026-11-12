import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { newRecord } from '../src/store.ts';

let root: string | undefined;
afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});

test('only the operator can register, clone, or remove teammates', async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-roster-authority-'));
	await writeFile(join(root, 'source.json'), JSON.stringify(newRecord('source', root, 'codex')));
	for (const agent of ['engineer', 'pm']) {
		const runtime = join(root, 'runtime', agent);
		await mkdir(runtime, { recursive: true });
		await writeFile(
			join(runtime, 'activity.json'),
			JSON.stringify({
				workingOn: '',
				state: 'idle',
				updatedAt: new Date().toISOString(),
				nonce: 'test-launch',
			}),
		);
	}
	const invoke = async (args: string[], agent: string) => {
		const child = Bun.spawn([process.execPath, resolve('src/cli.ts'), ...args], {
			env: {
				...process.env,
				SUMMON_HOME: root,
				SUMMON_AGENT: agent,
				SUMMON_NONCE: agent ? 'test-launch' : '',
			},
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return { code: await child.exited, error: await new Response(child.stderr).text() };
	};
	for (const agent of ['engineer', 'pm']) {
		for (const args of [['new-person'], ['clone', 'source', 'copy'], ['--remove', 'source']]) {
			const result = await invoke(args, agent);
			expect(result.code).not.toBe(0);
			expect(result.error).toContain('human operator only');
		}
	}
	expect(
		(await readdir(root)).filter((name) => ['new-person.json', 'copy.json'].includes(name)),
	).toEqual([]);
	expect((await invoke(['clone', 'source', 'copy'], '')).code).toBe(0);
	expect(await readdir(root)).toContain('copy.json');
}, 30_000);
