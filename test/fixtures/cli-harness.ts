import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { type AgentRecord, newRecord, type Provider, rememberSession } from '../../src/store.ts';
interface Launch {
	agentGuard?: string;
	claudeConfigDir?: string;
	cmd: string[];
	cwd?: string;
	detached?: boolean;
	summonNonce?: string;
}
export async function cliHarness() {
	const root = await mkdtemp(join(tmpdir(), 'summon-cli-test-'));
	const project = join(root, 'project with spaces');
	const records = join(root, 'agents');
	const teams = join(root, 'teams');
	const capture = join(root, 'launches.jsonl');
	await mkdir(project);
	await mkdir(records);
	async function invoke(args: string[], extraEnv: Record<string, string> = {}, input = 'yes\n') {
		await writeFile(capture, '');
		const child = Bun.spawn({
			cmd: [
				process.execPath,
				'--preload',
				join(import.meta.dir, 'capture-launch.ts'),
				join(import.meta.dir, '../../src/cli.ts'),
				...args,
			],
			cwd: project,
			env: {
				...process.env,
				SUMMON_HOME: records,
				SUMMON_TEAMS_HOME: teams,
				CODEX_HOME: join(root, 'codex'),
				GROK_HOME: join(root, 'grok'),
				SUMMON_TEST_CAPTURE: capture,
				SUMMON_TEST_EXIT: '0',
				SUMMON_TEST_SPAWN_ERROR: '0',
				...extraEnv,
			},
			stdin: new Blob([input]),
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const output = (await readFile(capture, 'utf8')).trim();
		const launches = output ? output.split('\n').map((line) => JSON.parse(line) as Launch) : [];
		return { stdout, stderr, code, launches };
	}

	async function seed(provider: Provider): Promise<AgentRecord> {
		const record = newRecord('Member', project, provider);
		record.expertise = 'Keeps my existing context.';
		await writeFile(join(records, 'member.md'), 'A note from an earlier session.\n');
		rememberSession(record, 'existing-session');
		await writeFile(join(records, 'member.json'), JSON.stringify(record));
		if (provider === 'codex') {
			// A captured provider has no real profile; provide only its own synthetic metadata source.
			const home = join(root, 'codex');
			await mkdir(join(home, 'sessions'), { recursive: true });
			const path = join(home, 'sessions', 'existing.jsonl');
			await writeFile(
				path,
				[
					{ type: 'session_meta', payload: { id: 'existing-session' } },
					{
						type: 'compacted',
						timestamp: '2026-01-01T00:00:00.000Z',
						payload: {
							window_id: 'synthetic-window',
							compaction_response_id: 'synthetic-response',
						},
					},
				]
					.map((entry) => JSON.stringify(entry))
					.join('\n') + '\n',
			);
			const database = new Database(join(home, 'state_5.sqlite'));
			try {
				database.run(
					'CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT)',
				);
				database
					.query('INSERT OR REPLACE INTO threads VALUES (?, ?)')
					.run('existing-session', path);
			} finally {
				database.close();
			}
		}
		return record;
	}

	async function saved(): Promise<AgentRecord> {
		return JSON.parse(await readFile(join(records, 'member.json'), 'utf8')) as AgentRecord;
	}

	async function dispose() {
		const target = resolve(root);
		if (
			dirname(target) !== resolve(tmpdir()) ||
			!basename(target).startsWith('summon-cli-test-')
		) {
			throw new Error('Refusing to remove an unexpected test directory.');
		}
		await rm(target, { recursive: true, force: true });
	}
	return { root, project, records, teams, invoke, seed, saved, dispose };
}
