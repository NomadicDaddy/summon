import { expect, test } from 'bun:test';

import type { readCompactions } from '../src/compaction-history.ts';

import { mailHarness } from './fixtures/mail-harness.ts';
import { ownedCommand } from './fixtures/owned-command.ts';

test.each(['2026-10-08T20:00:00.123Z', '2026-10-08T20:00:00.123456789+00:00'])(
	'actual configured Grok command retains native timestamp %s through the shell',
	async (timestamp) => {
		const fixture = await mailHarness();
		// Timed-out async cleanup can run during the next case. Keep its environment
		// in a separate process instead of restoring shared SUMMON_HOME.
		const command = ownedCommand(
			[`${import.meta.dir}/fixtures/grok-compaction-command.ts`, fixture.root, timestamp],
			{ ...process.env, SUMMON_HOME: fixture.records },
			// Two sequential hooks each permit five seconds, plus fixture setup and teardown.
			12000,
		);
		let safeToRemove = false;
		try {
			const { exit, stdout, stderr, timedOut } = await command.completion;
			safeToRemove = true;
			expect(timedOut).toBe(false);
			expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
			const history = JSON.parse(stdout) as Awaited<ReturnType<typeof readCompactions>>;
			expect(history.retainedObservations).toBe(2);
			expect(history.entries.map(({ record }) => record.phase).sort()).toEqual([
				'end',
				'start',
			]);
			expect(history.entries.every(({ record }) => record.nativeAt === timestamp)).toBe(true);
			expect(JSON.stringify(history)).not.toContain('PRIVATE_MUST_NOT_PERSIST');
		} finally {
			if (safeToRemove) await fixture.dispose();
			else console.error(`Unproven fixture cleanup; retained ${fixture.root}`);
		}
	},
	20000,
);
