import { afterEach, beforeEach, expect, test } from 'bun:test';

import { initializeActivity } from '../src/agent-activity.ts';
import { currentMailInputs } from '../src/current-request-mail.ts';
import { tickRest } from '../src/desktop/rest.ts';
import { Team } from '../src/desktop/team.ts';
import { prepareMailNotice } from '../src/mail-notice.ts';
import { header, statePath } from '../src/mail-read.ts';
import { pendingMessages, sendMessage } from '../src/mailbox.ts';
import { responseMailInventory } from '../src/response-watchdog-mail.ts';
import { responseTargetRetired } from '../src/response-watchdog-retired.ts';
import { readRest, refreshRest, stopForRest } from '../src/rest.ts';
import { loadAgent, providers, saveAgent } from '../src/store.ts';
import { bindIdleCodex } from './fixtures/codex-idle.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeActivity('alpha', 'test-launch');
	await initializeActivity('beta', 'test-launch');
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

test.each(providers.flatMap((provider) => [false, true].map((stopped) => ({ provider, stopped }))))(
	'$provider stopped=$stopped: readiness sends no PM mail; retained bookkeeping cannot wake it',
	async ({ provider, stopped }) => {
		const pm = await loadAgent('alpha');
		if (!pm) throw new Error('Missing fixture PM');
		pm.provider = provider;
		pm.memberType = 'pm';
		await saveAgent('alpha', pm);
		expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
		const initial = await readRest('alpha');
		if (!initial) throw new Error('Missing PM confirmation');
		if (stopped) {
			if (provider === 'codex') await bindIdleCodex(fixture.records, 'alpha', 'test-launch');
			await stopForRest('alpha', initial.id, () => Promise.resolve(), provider);
		}
		expect((await fixture.run(['--rest', 'ready'], 'beta')).code).toBe(0);
		const member = await readRest('beta');
		if (!member) throw new Error('Missing member confirmation');
		expect(await pendingMessages('alpha')).toEqual([]);
		expect((await fixture.run(['--rest', 'ready'], 'beta')).code).toBe(0);
		expect((await readRest('beta'))?.id).toBe(member.id);
		expect(await pendingMessages('alpha')).toEqual([]);
		// Previously stored bookkeeping remains inert; ordinary mail below is the positive control.
		await sendMessage('beta', 'alpha', 'Retained readiness observation', {
			id: member.id,
			kind: 'rest-ready',
		});
		const mail = await header('alpha', member.id);
		expect(mail.kind).toBe('rest-ready');
		expect(await pendingMessages('alpha')).toEqual([`${member.id}.md`]);
		expect(await Bun.file(statePath('alpha', member.id, 'read')).exists()).toBe(false);
		expect((await refreshRest('alpha'))?.mode).toBe(stopped ? 'stopped' : 'ready');
		expect(await prepareMailNotice('alpha', 'test-launch')).toBeUndefined();
		expect(await currentMailInputs('alpha', new Date().toISOString())).toEqual([]);
		expect(await responseMailInventory('alpha')).toEqual({ targets: [], failed: false });
		expect(
			await responseTargetRetired('alpha', {
				source: 'mail',
				key: 'inbox',
				through: 0,
				ids: [member.id],
			}),
		).toBe(true);
		const team = new Team(
			'bun',
			'cli.ts',
			() => {},
			() => {
				throw new Error('Bookkeeping must not launch a provider');
			},
		);
		await tickRest(team);
		expect((await readRest('alpha'))?.id).toBe(initial.id);
		expect((await readRest('alpha'))?.mode).toBe(stopped ? 'stopped' : 'ready');
		// Cancellation does not turn the retained observation into fresh work.
		expect((await fixture.run(['--rest', 'cancel'], 'beta')).code).toBe(0);
		expect(await prepareMailNotice('alpha', 'test-launch')).toBeUndefined();
		expect((await refreshRest('alpha'))?.mode).toBe(stopped ? 'stopped' : 'ready');
		// A legacy or ordinary request with identical prose remains substantive.
		await sendMessage('beta', 'alpha', 'beta confirmed Zzz/rest readiness.');
		expect((await refreshRest('alpha'))?.mode).toBe('wake-requested');
		expect(await prepareMailNotice('alpha', 'test-launch')).toBeDefined();
		expect((await responseMailInventory('alpha')).targets).toHaveLength(1);
		expect(await pendingMessages('alpha')).toHaveLength(2);
		expect(await Bun.file(statePath('alpha', member.id, 'read')).exists()).toBe(false);
	},
);
