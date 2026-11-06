import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { newRecord } from '../../src/store.ts';

export async function mailHarness() {
	const root = await mkdtemp(join(tmpdir(), 'summon-workflow-'));
	const records = join(root, 'agents with spaces');
	await mkdir(records);
	const capture = join(root, 'capture.jsonl');
	await writeFile(capture, '');
	for (const name of ['alpha', 'beta']) {
		await writeFile(
			join(records, `${name}.json`),
			JSON.stringify(newRecord(name, root, 'claude')),
		);
		const runtime = join(records, 'runtime', name);
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
	return {
		root,
		records,
		capture,
		async run(args: string[], agent = '', overrides: Record<string, string> = {}) {
			const child = Bun.spawn({
				cmd: [
					process.execPath,
					'--preload',
					join(import.meta.dir, 'capture-launch.ts'),
					join(import.meta.dir, '../../src/cli.ts'),
					...args,
				],
				cwd: root,
				env: {
					...process.env,
					SUMMON_HOME: records,
					SUMMON_AGENT: agent,
					SUMMON_NONCE: agent ? 'test-launch' : '',
					CODEX_HOME: join(root, 'codex'),
					SUMMON_TEST_CAPTURE: capture,
					SUMMON_TEST_EXIT: '0',
					SUMMON_TEST_SPAWN_ERROR: '0',
					...overrides,
				},
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				windowsHide: true,
			});
			const [out, error, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { out, error, code };
		},
		read: (path: string) => readFile(join(records, path), 'utf8'),
		async dispose() {
			if (
				dirname(resolve(root)) !== resolve(tmpdir()) ||
				!basename(root).startsWith('summon-workflow-')
			)
				throw new Error('Invalid test cleanup path.');
			await rm(root, { recursive: true, force: true });
		},
	};
}
