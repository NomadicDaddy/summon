import { expect, test } from 'bun:test';
import { join } from 'node:path';

import type { ResponseEpisode } from '../src/response-watchdog-model.ts';

import { mailHarness } from './fixtures/mail-harness.ts';

test('new evaluator processes retain same-launch timing, episode and dismissal', async () => {
	const fixture = await mailHarness();
	try {
		const run = async (now: number, dismiss = false) => {
			const child = Bun.spawn({
				cmd: [
					process.execPath,
					join(import.meta.dir, 'fixtures/response-watchdog-reload.ts'),
					String(now),
					dismiss ? 'dismiss' : 'observe',
				],
				env: {
					...process.env,
					SUMMON_HOME: fixture.records,
					SUMMON_AGENT: 'alpha',
					SUMMON_NONCE: 'reload-fixture',
				},
				stdout: 'pipe',
				stderr: 'pipe',
				windowsHide: true,
			});
			const [out, error, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(error).toBe('');
			expect(code).toBe(0);
			return JSON.parse(out) as ResponseEpisode & { phase: string };
		};
		const initial = await run(1000000);
		expect(initial.phase).toBe('observing');
		const alerted = await run(1600000);
		expect(alerted.id).toBe(initial.id);
		expect(alerted.phase).toBe('attention');
		expect(alerted.expectations[0]?.progressAt).toBe(1000000);
		const dismissed = await run(1700000, true);
		expect(dismissed.phase).toBe('dismissed');
		const reloaded = await run(2300000);
		expect(reloaded.id).toBe(initial.id);
		expect(reloaded.phase).toBe('dismissed');
		expect(reloaded.expectations).toHaveLength(1);
	} finally {
		await fixture.dispose();
	}
});
