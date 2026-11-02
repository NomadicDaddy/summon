import { afterEach, beforeEach, expect, test } from 'bun:test';

import { initializeActivity, readActivity } from '../src/agent-activity.ts';
import { unreadMailCount } from '../src/desktop/mail-count.ts';
import { receiveMail } from '../src/mail-read.ts';
import { acknowledgeMessage, sendMessage } from '../src/mailbox.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const original = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (original === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = original;
	await fixture.dispose();
});

test('self-defined activity is bounded, launch-owned, and reset on restart', async () => {
	await initializeActivity('alpha', 'test-launch');
	expect((await fixture.run(['--status', 'busy', 'Testing team UI'], 'alpha')).code).toBe(0);
	expect((await readActivity('alpha'))?.state).toBe('busy');
	expect((await readActivity('alpha'))?.workingOn).toBe('Testing team UI');
	expect((await fixture.run(['--status', 'needs-user', 'Choose a shell'], 'alpha')).code).toBe(0);
	expect((await readActivity('alpha'))?.state).toBe('needs-user');
	expect((await fixture.run(['--status', 'busy', 'x'.repeat(121)], 'alpha')).code).toBe(1);
	expect((await fixture.run(['--status', 'busy', 'invalid\ntext'], 'alpha')).code).toBe(1);
	expect((await fixture.run(['--status', 'idle', 'Available'])).code).toBe(1);
	expect((await fixture.run(['--status', 'idle', 'Available'], 'beta')).code).toBe(1);
	await initializeActivity('alpha', 'new-launch');
	expect((await readActivity('alpha'))?.state).toBe('idle');
	expect((await readActivity('alpha'))?.workingOn).toBe('');
	expect((await fixture.run(['--status', 'busy', 'Stale writer'], 'alpha')).code).toBe(1);
});

test('operator unread count excludes read but unarchived mail and handles offline mail', async () => {
	expect(await unreadMailCount('alpha')).toBe(0);
	const id = await sendMessage('beta', 'alpha', 'Disposable unread request');
	expect(await unreadMailCount('alpha')).toBe(1);
	await receiveMail('alpha');
	expect(await unreadMailCount('alpha')).toBe(0);
	await acknowledgeMessage('alpha', id);
	expect(await unreadMailCount('alpha')).toBe(0);
	await sendMessage('beta', 'alpha', 'Another request');
	expect(await unreadMailCount('alpha')).toBe(1);
	const previousAgent = process.env.SUMMON_AGENT;
	process.env.SUMMON_AGENT = 'alpha';
	try {
		expect(await unreadMailCount('beta').catch((error: unknown) => String(error))).toContain(
			'human operator',
		);
	} finally {
		if (previousAgent === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = previousAgent;
	}
});
