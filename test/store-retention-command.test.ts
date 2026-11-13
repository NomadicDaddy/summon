import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const owner = 'fixture-retention';
const run = (n: number, runOwner = owner) => ({
	id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
	scheduleId: '00000000-0000-4000-8000-000000000001',
	owner: runOwner,
	title: 'fixture',
	prompt: 'fixture',
	dueAt: 1,
	updatedAt: 2,
	status: 'complete',
});

async function invoke(root: string, args: string[]) {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith('SUMMON_')),
	);
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			join(import.meta.dir, '../src/cli.ts'),
			'--store-retention',
			...args,
		],
		env: { ...env, SUMMON_HOME: root, SUMMON_AGENT: owner, SUMMON_NONCE: 'fixture-launch' },
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

test('real CLI pages owned schedule IDs, rejects changed generations and never rewrites state', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-store-retention-'));
	const target = resolve(root);
	if (
		dirname(target) !== resolve(tmpdir()) ||
		!basename(target).startsWith('summon-store-retention-')
	)
		throw new Error('Unexpected disposable fixture path.');
	try {
		const dir = join(root, 'schedules');
		await mkdir(dir);
		const runtime = join(root, 'runtime', owner);
		await mkdir(runtime, { recursive: true });
		await writeFile(
			join(runtime, 'activity.json'),
			JSON.stringify({
				state: 'idle',
				workingOn: '',
				nonce: 'fixture-launch',
				updatedAt: new Date().toISOString(),
			}),
		);
		const path = join(dir, 'state.json');
		const state = {
			version: 1,
			schedules: [],
			runs: [...Array.from({ length: 11 }, (_, n) => run(n + 1)), run(99, 'another-owner')],
		};
		const original = JSON.stringify(state);
		await writeFile(path, original);
		const first = await invoke(root, ['preview']);
		if (first.code !== 0) throw new Error(first.stderr);
		expect(first.code).toBe(0);
		const page = JSON.parse(first.stdout) as {
			readOnly: boolean;
			applyAvailable: boolean;
			eligibleCount: number;
			rows: { runId: string; status: string; stateAfterHash: string | null }[];
			next: string | null;
		};
		expect(page.readOnly).toBe(true);
		expect(page.applyAvailable).toBe(false);
		expect(page.eligibleCount).toBe(0);
		expect(page.rows).toHaveLength(10);
		expect(page.rows.every((row) => row.status === 'KEEP' && row.stateAfterHash === null)).toBe(
			true,
		);
		expect(page.rows.map((row) => row.runId)).not.toContain(run(99).id);
		const second = await invoke(root, ['preview', '--cursor', page.next ?? '']);
		expect(second.code).toBe(0);
		expect((JSON.parse(second.stdout) as { rows: unknown[] }).rows).toHaveLength(1);
		expect(await readFile(path, 'utf8')).toBe(original);
		expect((await invoke(root, ['apply'])).code).not.toBe(0);
		await writeFile(path, JSON.stringify({ ...state, runs: state.runs.slice(1) }));
		const stale = await invoke(root, ['preview', '--cursor', page.next ?? '']);
		expect(stale.code).not.toBe(0);
		expect(stale.stderr).toContain('Retention inputs changed');
	} finally {
		await rm(target, { recursive: true, force: true });
	}
});
