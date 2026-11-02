import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity, readActivity } from '../src/agent-activity.ts';
import { currentMailInputs } from '../src/current-request-mail.ts';
import { nudgeRest } from '../src/desktop/rest-nudge.ts';
import { Team } from '../src/desktop/team.ts';
import { optionalText } from '../src/mail-files.ts';
import { prepareMailNotice } from '../src/mail-notice.ts';
import { confirmMessage, header, receiveMail, statePath } from '../src/mail-read.ts';
import { pendingMessages, sendMessage } from '../src/mailbox.ts';
import { restEvidence } from '../src/rest-evidence.ts';
import { readRest } from '../src/rest.ts';
import { newRecord } from '../src/store.ts';
import { parseSystemMail } from '../src/system-mail.ts';
import { bindIdleCodex } from './fixtures/codex-idle.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { bindIdleTurn } from './fixtures/provider-idle.ts';

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

test.each(['claude', 'codex', 'grok', 'kilo'] as const)(
	'%s generated nudge expires across launches without hiding or acknowledging its body',
	async (provider) => {
		await writeFile(
			join(fixture.records, 'alpha.json'),
			JSON.stringify(newRecord('alpha', fixture.root, provider)),
		);
		await initializeActivity('alpha', 'test-launch', provider);
		const team = new Team(
			'bun',
			'cli.ts',
			() => {},
			() => ({
				pid: 1,
				onData: () => ({ dispose() {} }),
				onExit: () => ({ dispose() {} }),
				write() {},
				resize() {},
				kill() {},
			}),
		);
		await team.start('alpha');
		// The nudge needs idle activity from the session's own launch (tool-aware-idle-nudge).
		const launch = team.sessions.get('alpha')?.launch.nonce ?? 'no-session';
		await initializeActivity('alpha', launch, provider);
		// Turn evidence isn't this test's subject; give the launch an observed idle turn. For Codex
		// that's its bound thread's daemon status.
		if (provider === 'codex') await bindIdleCodex(fixture.records, 'alpha', launch);
		else await bindIdleTurn(fixture.records, provider, 'alpha', launch);
		await nudgeRest(team, 'alpha', Date.now() + 11 * 60000);
		const [file] = await pendingMessages('alpha');
		if (!file) throw new Error('Expected generated nudge');
		const id = file.slice(0, -3);
		const path = join(fixture.records, 'mailboxes/alpha/inbox', file);
		const original = await Bun.file(path).text();
		expect((await header('alpha', id)).kind).toBe('notice');
		expect((await header('alpha', id)).noticeStatus).toBe('current');
		const prepared = await prepareMailNotice('alpha', launch);
		expect(await prepared?.needed()).toBe(true);
		await initializeActivity('alpha', 'new-launch', provider);
		expect((await header('alpha', id)).noticeStatus).toBe('obsolete');
		expect(await prepared?.needed()).toBe(false);
		expect(await prepareMailNotice('alpha', 'new-launch')).toBeUndefined();
		expect(await currentMailInputs('alpha', new Date().toISOString())).toEqual([]);
		expect((await restEvidence('alpha')).reason).toBe('');
		await Bun.write(join(fixture.records, 'runtime/alpha/new-launch.ready'), 'new-launch');
		expect(
			(await fixture.run(['--rest', 'ready'], 'alpha', { SUMMON_NONCE: 'new-launch' })).code,
		).toBe(0);
		expect((await readRest('alpha'))?.mode).toBe('ready');
		const pending = await receiveMail('alpha', '', false, 'pending');
		expect(pending.messages[0]?.header.noticeStatus).toBe('obsolete');
		expect(pending.messages[0]?.text).toBe(original);
		expect(await optionalText(statePath('alpha', id, 'read'))).toBeUndefined();
		expect(await Bun.file(path).text()).toBe(original);
		const checkpoint = await fixture.run(['--checkpoint'], 'alpha', {
			SUMMON_NONCE: 'new-launch',
		});
		expect(checkpoint.code).toBe(0);
		expect(checkpoint.out).toContain('obsolete');
		expect(checkpoint.out).toContain('You have been idle');
		expect(await optionalText(statePath('alpha', id, 'read'))).toBeUndefined();
	},
);

test('ordinary self-mail with reminder wording is still a request that vetoes rest', async () => {
	await initializeActivity('alpha', 'test-launch');
	const id = await sendMessage(
		'alpha',
		'alpha',
		'You have been idle for a while. Please check your cards.',
	);
	await initializeActivity('alpha', 'later-launch');
	const mail = await header('alpha', id);
	expect(mail.kind).toBe('request');
	expect(mail.noticeStatus).toBeUndefined();
	expect(await prepareMailNotice('alpha', 'later-launch')).toBeDefined();
	expect((await restEvidence('alpha')).reason).toBe('Unread mail needs attention');
});

test('a rest-ended notice expires when a later rest confirmation replaces its episode', async () => {
	await initializeActivity('alpha', 'test-launch');
	const confirmation = randomUUID();
	const state = {
		id: confirmation,
		mode: 'awake',
		board: '',
		through: 0,
		nonce: 'test-launch',
		resume: false,
		reason: 'Fixture wake completed',
	};
	const restPath = join(fixture.records, 'runtime/alpha/rest.json');
	await Bun.write(restPath, JSON.stringify(state));
	const id = await sendMessage('alpha', 'alpha', 'Rest ended fixture', {
		system: {
			purpose: 'rest-ended',
			nonce: 'test-launch',
			confirmation,
			previousActivityNonce: 'earlier-launch',
		},
	});
	expect((await header('alpha', id)).noticeStatus).toBe('current');
	const prepared = await prepareMailNotice('alpha', 'test-launch');
	expect(await prepared?.needed()).toBe(true);
	await Bun.write(restPath, JSON.stringify({ ...state, id: randomUUID(), mode: 'ready' }));
	expect((await header('alpha', id)).noticeStatus).toBe('obsolete');
	expect(await prepared?.needed()).toBe(false);
	expect(await pendingMessages('alpha')).toEqual([`${id}.md`]);
	expect(await optionalText(statePath('alpha', id, 'read'))).toBeUndefined();
});

test('becoming busy preserves a reminder; notices do not generate self-receipt loops', async () => {
	await initializeActivity('alpha', 'test-launch');
	const activity = await readActivity('alpha');
	if (!activity) throw new Error('Missing activity');
	const id = await sendMessage('alpha', 'alpha', 'Generated reminder', {
		system: {
			purpose: 'rest-nudge',
			nonce: activity.nonce,
			idleSince: activity.updatedAt,
		},
	});
	expect((await fixture.run(['--status', 'busy', 'Working'], 'alpha')).code).toBe(0);
	expect((await header('alpha', id)).noticeStatus).toBe('current');
	expect(await prepareMailNotice('alpha', 'test-launch')).toBeDefined();
	await receiveMail('alpha');
	expect(await pendingMessages('alpha')).toEqual([`${id}.md`]);
	expect(await confirmMessage('alpha', id, 'Not a request').catch(String)).toContain(
		'Only substantive requests',
	);
});

test('unknown notice metadata preserves its body and unrelated mail delivery', async () => {
	await initializeActivity('alpha', 'test-launch');
	const id = await sendMessage('alpha', 'alpha', 'Future generated reminder', {
		system: {
			purpose: 'rest-nudge',
			nonce: 'test-launch',
			idleSince: new Date().toISOString(),
		},
	});
	const path = join(fixture.records, 'mailboxes/alpha/inbox', `${id}.md`);
	const original = (await Bun.file(path).text()).replace('"rest-nudge"', '"future-purpose"');
	await Bun.write(path, original);
	await sendMessage('beta', 'alpha', 'Legitimate work stays deliverable');
	expect((await header('alpha', id)).noticeStatus).toBe('unverifiable');
	expect(await prepareMailNotice('alpha', 'test-launch')).toBeDefined();
	expect((await restEvidence('alpha')).reason).toBe('Unread mail needs attention');
	const pending = await receiveMail('alpha', '', false, 'pending');
	expect(pending.messages).toHaveLength(2);
	expect(pending.errors).toHaveLength(0);
	expect(pending.messages.find((item) => item.header.id === id)?.text).toBe(original);
	expect(await Bun.file(path).text()).toBe(original);
	expect(await optionalText(statePath('alpha', id, 'read'))).toBeUndefined();
});

test('unverifiable notices remain eligible and malformed or foreign provenance is refused', async () => {
	const system = {
		purpose: 'rest-nudge' as const,
		nonce: 'test-launch',
		idleSince: new Date().toISOString(),
	};
	const id = await sendMessage('alpha', 'alpha', 'Inspect missing activity', { system });
	expect((await header('alpha', id)).noticeStatus).toBe('unverifiable');
	expect(await prepareMailNotice('alpha', 'test-launch')).toBeDefined();
	expect(await sendMessage('alpha', 'beta', 'Not self-mail', { system }).catch(String)).toContain(
		'must be self-mail',
	);
	expect(
		await sendMessage('alpha', 'alpha', 'Conflicting kind', { system, kind: 'request' }).catch(
			String,
		),
	).toContain('must be self-mail');
	expect(() => parseSystemMail({ ...system, nonce: 'bad\nlaunch' })).toThrow('Invalid generated');
	expect(() => parseSystemMail({ ...system, purpose: 'unknown' })).toThrow('Invalid generated');
	expect(() => parseSystemMail({ ...system, private: 'UNEXPECTED' })).toThrow(
		'Invalid generated',
	);
});

test('a first-launch rest notice waits for activity and expires after a later launch', async () => {
	const confirmation = randomUUID();
	await Bun.write(
		join(fixture.records, 'runtime/alpha/rest.json'),
		JSON.stringify({
			id: confirmation,
			mode: 'awake',
			board: '',
			through: 0,
			nonce: 'first-launch',
			resume: false,
			reason: 'Fixture wake',
		}),
	);
	const id = await sendMessage('alpha', 'alpha', 'First-launch rest notice', {
		system: {
			purpose: 'rest-ended',
			nonce: 'first-launch',
			confirmation,
			previousActivityNonce: null,
		},
	});
	expect((await header('alpha', id)).noticeStatus).toBe('unverifiable');
	await initializeActivity('alpha', 'first-launch');
	expect((await header('alpha', id)).noticeStatus).toBe('current');
	await initializeActivity('alpha', 'later-launch');
	expect((await header('alpha', id)).noticeStatus).toBe('obsolete');
	expect(await prepareMailNotice('alpha', 'later-launch')).toBeUndefined();
	expect(await optionalText(statePath('alpha', id, 'read'))).toBeUndefined();
});
