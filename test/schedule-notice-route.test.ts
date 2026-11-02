import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { setCommunicationPause } from '../src/communication-state.ts';
import { tickSchedules } from '../src/desktop/schedules.ts';
import { Team } from '../src/desktop/team.ts';
import { terminalDraft } from '../src/desktop/terminal-draft.ts';
import { pendingMessages } from '../src/mailbox.ts';
import { createSchedule, listSchedules } from '../src/schedules.ts';
import { newRecord, updateAgentRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
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

async function harness(provider: 'claude' | 'codex' | 'grok' | 'kilo') {
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
			pid: process.pid,
			onData: () => ({ dispose: () => {} }),
			onExit: () => ({ dispose: () => {} }),
			write: (text) => inputs.push(String(text)),
			resize: () => {},
			kill: () => {},
		}),
	);
	await team.start('alpha', false);
	return { team, inputs };
}

async function due() {
	await createSchedule({
		owner: 'alpha',
		title: 'Review',
		everyMinutes: 1,
		prompt: 'Fixture only.',
	});
	const state = await listSchedules();
	const schedule = state.schedules[0];
	if (!schedule) throw new Error('Missing fixture schedule.');
	schedule.nextDueAt = 0;
	await writeFile(join(fixture.records, 'schedules/state.json'), JSON.stringify(state));
}

test.each(['claude', 'codex', 'grok', 'kilo'] as const)(
	'%s scheduled mail has one route following the running launch and creates no draft',
	async (provider) => {
		const h = await harness(provider);
		await due();
		await updateAgentRecord('alpha', (record) => {
			record.provider = provider === 'kilo' ? 'grok' : 'kilo';
		});
		await tickSchedules(h.team);
		await tickSchedules(h.team);
		expect(await pendingMessages('alpha')).toHaveLength(1);
		expect((await listSchedules()).runs).toHaveLength(1);
		expect(h.inputs).toHaveLength(0);
		if (provider === 'kilo') {
			const stop = await attachFixtureReceiver(h.team, 'alpha');
			try {
				await waitForNotice(h.inputs, 'mailbox event');
				expect(h.inputs).toHaveLength(1);
			} finally {
				await stop();
			}
		}
		const session = h.team.sessions.get('alpha');
		if (!session) throw new Error('Missing fixture session.');
		expect(terminalDraft(session.pty)).toEqual({ version: 0, draft: false });
	},
);

test('Kilo due work remains unclaimed behind a human draft or halt, then delivers once', async () => {
	const h = await harness('kilo');
	await due();
	await h.team.input('alpha', 'unfinished human text\r');
	await tickSchedules(h.team);
	expect((await listSchedules()).runs).toHaveLength(0);
	expect((await listSchedules()).schedules[0]?.nextDueAt).toBe(0);
	expect(await pendingMessages('alpha')).toHaveLength(0);
	expect(h.inputs).toHaveLength(1);
	await h.team.input('alpha', '\r');
	await setCommunicationPause(true);
	await tickSchedules(h.team);
	expect((await listSchedules()).runs).toHaveLength(0);
	await setCommunicationPause(false);
	await tickSchedules(h.team);
	await tickSchedules(h.team);
	expect((await listSchedules()).runs).toHaveLength(1);
	expect(await pendingMessages('alpha')).toHaveLength(1);
	expect(h.inputs).toHaveLength(2);
	const stop = await attachFixtureReceiver(h.team, 'alpha');
	try {
		await waitForNotice(h.inputs, 'mailbox event');
		expect(h.inputs).toHaveLength(3);
	} finally {
		await stop();
	}
});
