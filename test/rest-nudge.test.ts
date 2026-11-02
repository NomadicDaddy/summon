import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { createBoardItem } from '../src/board.ts';
import { nudgeRest } from '../src/desktop/rest-nudge.ts';
import { Team } from '../src/desktop/team.ts';
import { pendingMessages, sendMessage } from '../src/mailbox.ts';
import { readRest } from '../src/rest.ts';
import { newRecord } from '../src/store.ts';
import { bindIdleCodex } from './fixtures/codex-idle.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { bindIdleTurn } from './fixtures/provider-idle.ts';
import { attachFixtureReceiver, waitForNotice } from './fixtures/wake-team.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeActivity('alpha', 'test-launch');
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

test.each(['claude', 'codex', 'kilo', 'grok'] as const)(
	'%s idle question reaches an owner with outstanding work without granting rest',
	async (provider) => {
		await writeFile(
			join(fixture.records, 'alpha.json'),
			JSON.stringify(newRecord('alpha', fixture.root, provider)),
		);
		const inputs: string[] = [];
		const team = new Team(
			'bun',
			'cli.ts',
			() => {},
			() => ({
				pid: 1,
				onData: () => ({ dispose() {} }),
				onExit: () => ({ dispose() {} }),
				write: (value) => {
					inputs.push(String(value));
				},
				resize() {},
				kill() {},
			}),
		);
		await team.start('alpha');
		// The nudge needs idle activity from the session's own launch (tool-aware-idle-nudge).
		const launch = team.sessions.get('alpha')?.launch.nonce ?? 'no-session';
		await initializeActivity('alpha', launch);
		// Turn evidence isn't this test's subject; give the launch an observed idle turn. For Codex
		// that's its bound thread's daemon status.
		if (provider === 'codex') await bindIdleCodex(fixture.records, 'alpha', launch);
		else await bindIdleTurn(fixture.records, provider, 'alpha', launch);
		await createBoardItem({
			title: 'Reconcile stale or actionable work',
			owner: 'alpha',
			state: 'ready',
		});
		await sendMessage('beta', 'alpha', 'Unread request to assess');
		await nudgeRest(team, 'alpha', Date.now() + 9 * 60000);
		expect(await pendingMessages('alpha')).toHaveLength(1);
		await nudgeRest(team, 'alpha', Date.now() + 11 * 60000);
		await nudgeRest(team, 'alpha', Date.now() + 12 * 60000);
		expect(await pendingMessages('alpha')).toHaveLength(2);
		expect(inputs).toHaveLength(0);
		if (provider === 'kilo') {
			const stop = await attachFixtureReceiver(team, 'alpha');
			try {
				await waitForNotice(inputs, 'mailbox event');
				expect(inputs).toHaveLength(1);
			} finally {
				await stop();
			}
		}
		expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(1);
		expect(await readRest('alpha')).toBeUndefined();
		expect(team.sessions.get('alpha')?.agent.status).toBe('running');
	},
);
