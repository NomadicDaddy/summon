import { afterEach, beforeEach, expect, test } from 'bun:test';

import { initializeActivity } from '../src/agent-activity.ts';
import { Team } from '../src/desktop/team.ts';
import { stopTerminalReceivers, syncTerminalReceivers } from '../src/desktop/terminal-receivers.ts';
import { deliveryNotice } from '../src/mail-notice.ts';
import { saveDelivery } from '../src/mail-session.ts';
import { sendMessage } from '../src/mailbox.ts';
import { readRest } from '../src/rest.ts';
import { updateAgentRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

test('Grok submits readiness and work with spaces, without appending teammate rest', async () => {
	await updateAgentRecord('alpha', (record) => {
		record.provider = 'grok';
		record.memberType = 'pm';
	});
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
	try {
		await team.start('alpha', false);
		await initializeActivity('alpha', 'grok-lines');
		await initializeActivity('beta', 'test-launch');
		const ready = await fixture.run(['--rest', 'ready'], 'beta');
		expect(ready.code).toBe(0);
		const rest = await readRest('beta');
		if (!rest) throw new Error('Missing fixture rest confirmation.');
		await sendMessage('beta', 'alpha', 'Retained readiness observation', {
			id: rest.id,
			kind: 'rest-ready',
		});
		await sendMessage('beta', 'alpha', 'Real work still needs a notice.');
		await saveDelivery('alpha', {
			nonce: 'grok-lines',
			pid: process.pid,
			state: 'queued-only',
			reason: '',
			thread: 'disposable-grok-lines',
		});
		await syncTerminalReceivers(team);
		const deadline = Date.now() + 8000;
		while (inputs.length === 0 && Date.now() < deadline) await Bun.sleep(20);
		expect(inputs).toEqual([
			`${deliveryNotice('alpha', 'grok-lines', false, 0, 0)} ${deliveryNotice('alpha', 'grok-lines', true, 1, 0)}\r`,
		]);
	} finally {
		await stopTerminalReceivers(team);
	}
});
