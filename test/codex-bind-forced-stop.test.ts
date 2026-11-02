import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { cliHarness } from './fixtures/cli-harness.ts';

test('a force-stopped wrapper retains its already-bound Codex conversation for exact resume', async () => {
	const fixture = await cliHarness();
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			'--preload',
			join(import.meta.dir, 'fixtures/capture-launch.ts'),
			join(import.meta.dir, '../src/cli.ts'),
			'member',
			'--using',
			'codex',
			'--same-window',
		],
		cwd: fixture.project,
		env: {
			...process.env,
			SUMMON_HOME: fixture.records,
			SUMMON_AGENT: '',
			SUMMON_NONCE: '',
			CODEX_HOME: join(fixture.root, 'codex'),
			SUMMON_TEST_CAPTURE: join(fixture.root, 'launches.jsonl'),
			SUMMON_TEST_CODEX_BINDING: 'exact-before-forced-stop',
			SUMMON_TEST_EXIT: '0',
			SUMMON_TEST_DELAY: '30000',
		},
		stdin: new Blob(['yes\n']),
		stdout: 'ignore',
		stderr: 'ignore',
		windowsHide: true,
	});
	let fixturePid: number | undefined;
	try {
		for (let i = 0; i < 200; i++) {
			const saved = await fixture.saved().catch(() => undefined);
			if (saved?.sessions.at(-1)?.id === 'exact-before-forced-stop') break;
			await Bun.sleep(25);
		}
		expect((await fixture.saved()).sessions.at(-1)?.id).toBe('exact-before-forced-stop');
		expect(child.exitCode).toBeNull();
		const owner = (await Bun.file(
			join(fixture.records, 'runtime/member/session.lock/owner.json'),
		).json()) as {
			pid: number;
			childPid: number;
		};
		expect(owner.pid).toBe(child.pid);
		expect(
			Number.isSafeInteger(owner.childPid) &&
				owner.childPid > 0 &&
				owner.childPid !== child.pid,
		).toBe(true);
		fixturePid = owner.childPid;
		if (process.platform === 'win32') {
			const stop = Bun.spawn(['taskkill.exe', '/PID', String(child.pid), '/T', '/F'], {
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				windowsHide: true,
			});
			const [code, out, error] = await Promise.all([
				stop.exited,
				new Response(stop.stdout).text(),
				new Response(stop.stderr).text(),
			]);
			if (code !== 0)
				throw new Error(`Disposable taskkill failed (${code}): ${out} ${error}`);
			expect(code).toBe(0);
			fixturePid = undefined;
		} else {
			child.kill(9);
			process.kill(fixturePid, 9);
			fixturePid = undefined;
		}
		await child.exited;
		expect((await fixture.saved()).sessions.map(({ id }) => id)).toEqual([
			'exact-before-forced-stop',
		]);
		const resumed = await fixture.invoke(['member', '--same-window']);
		expect(resumed.code).toBe(0);
		expect(resumed.launches[0]?.cmd.slice(0, 2)).toEqual(['codex', 'resume']);
		expect(resumed.launches[0]?.cmd).toContain('exact-before-forced-stop');
	} finally {
		if (child.exitCode === null) child.kill(9);
		await child.exited;
		if (fixturePid !== undefined) {
			try {
				process.kill(fixturePid, 9);
			} catch {
				/* Fixture already exited. */
			}
		}
		await fixture.dispose();
	}
}, 15000);
