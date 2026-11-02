import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { tickRest } from '../src/desktop/rest.ts';
import { Team, type TerminalProcess } from '../src/desktop/team.ts';
import { terminalDraft } from '../src/desktop/terminal-draft.ts';
import { sendHuman } from '../src/local-room-access.ts';
import { prepareMailNotice } from '../src/mail-notice.ts';
import { header } from '../src/mail-read.ts';
import { pendingMessages } from '../src/mailbox.ts';
import { readRest } from '../src/rest.ts';
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

test.each(['claude', 'codex', 'grok', 'kilo'] as const)(
	'%s rest-ended notification has one transport and does not become a human draft',
	async (provider) => {
		await writeFile(
			join(fixture.records, 'alpha.json'),
			JSON.stringify(newRecord('alpha', fixture.root, provider)),
		);
		const inputs: string[] = [];
		const pty: TerminalProcess = {
			pid: process.pid,
			onData: () => ({ dispose: () => {} }),
			onExit: () => ({ dispose: () => {} }),
			write: (text) => inputs.push(String(text)),
			resize: () => {},
			kill: () => {},
		};
		const team = new Team(
			'bun',
			'cli.ts',
			() => {},
			() => pty,
		);
		const ready = await fixture.run(['--rest', 'ready'], 'alpha');
		expect(ready.code).toBe(0);
		await team.start('alpha', false);
		const nonce = team.sessions.get('alpha')?.launch.nonce;
		if (!nonce) throw new Error('Missing owned launch');
		// Future provider edits must not choose a second route for the running launch.
		await updateAgentRecord('alpha', (record) => {
			record.provider = provider === 'kilo' ? 'grok' : 'kilo';
		});
		await sendHuman('@alpha fresh work after rest');
		// Keep the preceding launch's activity until the newly owned child initializes.
		await tickRest(team);
		await tickRest(team);
		expect((await readRest('alpha'))?.mode).toBe('awake');
		expect(await pendingMessages('alpha')).toHaveLength(1);
		const confirmation = (await readRest('alpha'))?.id;
		if (!confirmation) throw new Error('Missing rest confirmation');
		expect((await header('alpha', confirmation)).systemNotice?.purpose).toBe('rest-ended');
		expect((await header('alpha', confirmation)).noticeStatus).toBe('unverifiable');
		expect(await prepareMailNotice('alpha', nonce)).toBeDefined();
		await initializeActivity('alpha', nonce);
		expect((await header('alpha', confirmation)).noticeStatus).toBe('current');
		expect(inputs).toHaveLength(0);
		if (provider === 'kilo') {
			// This receiver observes the same launch that produced the wake notice.
			const stop = await attachFixtureReceiver(team, 'alpha', nonce);
			try {
				await waitForNotice(inputs, 'mailbox event');
				expect(inputs).toHaveLength(1);
				expect(inputs[0]).not.toContain('Rest ended:');
			} finally {
				await stop();
			}
		}
		expect(terminalDraft(pty)).toEqual({ version: 0, draft: false });
		await initializeActivity('alpha', 'later-launch');
		expect((await header('alpha', confirmation)).noticeStatus).toBe('obsolete');
		expect(await prepareMailNotice('alpha', 'later-launch')).toBeUndefined();
	},
);
