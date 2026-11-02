import { expect, test } from 'bun:test';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { trackResponseSafely } from '../src/response-watchdog-safety.ts';
import { evaluateResponseWatchdog } from '../src/response-watchdog.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { oldBuild } from './fixtures/old-build-rollback.ts';

test.each([false, true])(
	'exact old build preserves candidate history, recovered=%s',
	async (recoveredFailure) => {
		const fixture = await mailHarness();
		const previous = process.env.SUMMON_HOME;
		process.env.SUMMON_HOME = fixture.records;
		let unlinkDependencies: (() => Promise<void>) | undefined;
		try {
			const old = join(fixture.root, 'old-build');
			await mkdir(old);
			unlinkDependencies = await oldBuild(old);
			await initializeActivity('alpha', 'candidate-launch');
			await evaluateResponseWatchdog('alpha', 'candidate-launch');
			await trackResponseSafely('alpha', () =>
				Promise.reject(new Error('private fixture error')),
			);
			if (recoveredFailure) await trackResponseSafely('alpha', () => Promise.resolve(), true);
			const runtime = join(fixture.records, 'runtime/alpha');
			const before = new Map<string, string>();
			for (const file of await readdir(runtime, { recursive: true, withFileTypes: true })) {
				if (
					file.isFile() &&
					(file.name.startsWith('response-watchdog') ||
						file.parentPath.endsWith('response-watchdog-errors'))
				) {
					const path = join(file.parentPath, file.name);
					before.set(path, await Bun.file(path).text());
				}
			}
			const run = async (args: string[]) => {
				const child = Bun.spawn([process.execPath, ...args], {
					cwd: old,
					env: {
						...process.env,
						SUMMON_AGENT: 'alpha',
						SUMMON_NONCE: 'rollback-fresh-launch',
					},
					stdout: 'pipe',
					stderr: 'pipe',
					windowsHide: true,
				});
				const [code, out, error] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				return { code, out, error };
			};
			const status = await run([join(old, 'src/cli.ts'), '--mail', 'status']);
			expect(status.error).toBe('');
			expect(status.code).toBe(0);
			expect(before.size).toBeGreaterThan(0);
			const recovered = await run([
				join(import.meta.dir, 'fixtures/old-build-delivery.ts'),
				old,
			]);
			expect(recovered.code).toBe(0);
			expect(recovered.out).toContain('OLD_BUILD_RECOVERY_AND_DELIVERY_OK');
			for (const [file, bytes] of before) expect(await Bun.file(file).text()).toBe(bytes);
			expect((await run([join(old, 'src/cli.ts'), '--mail', 'status'])).code).toBe(0);
		} finally {
			await unlinkDependencies?.();
			if (previous === undefined) delete process.env.SUMMON_HOME;
			else process.env.SUMMON_HOME = previous;
			await fixture.dispose();
		}
	},
	20000,
);
