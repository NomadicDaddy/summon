import { afterEach, beforeEach, expect, test } from 'bun:test';

import { initializeActivity } from '../src/agent-activity.ts';
import { tickRest } from '../src/desktop/rest.ts';
import { Team } from '../src/desktop/team.ts';
import { pendingMessages, sendMessage } from '../src/mailbox.ts';
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
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

const cases = providers.flatMap((provider) => [
	{ provider, stopped: false },
	{ provider, stopped: true },
]);
test.each(cases)(
	'$provider stopped=$stopped: bookkeeping stays unread without waking',
	async ({ provider, stopped }) => {
		const record = await loadAgent('alpha');
		if (!record) throw new Error('Missing fixture member');
		record.provider = provider;
		await saveAgent('alpha', record);
		expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
		const initial = await readRest('alpha');
		if (!initial) throw new Error('Missing rest confirmation');
		if (stopped) {
			if (provider === 'codex') await bindIdleCodex(fixture.records, 'alpha', 'test-launch');
			await stopForRest('alpha', initial.id, () => Promise.resolve(), provider);
		}
		for (const kind of ['confirmation', 'receipt'] as const)
			await sendMessage('beta', 'alpha', 'Acknowledgement only, no new work.', { kind });
		expect((await refreshRest('alpha'))?.mode).toBe(stopped ? 'stopped' : 'ready');
		let launches = 0;
		const team = new Team(
			'bun',
			'cli.ts',
			() => {},
			() => {
				launches++;
				throw new Error('Bookkeeping must never start a provider');
			},
		);
		await tickRest(team);
		await tickRest(team);
		expect(launches).toBe(0);
		expect((await readRest('alpha'))?.id).toBe(initial.id);
		expect((await readRest('alpha'))?.mode).toBe(stopped ? 'stopped' : 'ready');
		expect(await pendingMessages('alpha')).toHaveLength(2);
		if (!stopped) expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
	},
);

test.each(
	providers.flatMap((provider) => ['request', 'reply'].map((kind) => ({ provider, kind }))),
)('$provider $kind: unread new work still invalidates rest', async ({ provider, kind }) => {
	const record = await loadAgent('alpha');
	if (!record) throw new Error('Missing fixture member');
	record.provider = provider;
	await saveAgent('alpha', record);
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
	await sendMessage('beta', 'alpha', 'New evidence needs your review.', {
		kind: kind === 'request' ? 'request' : 'reply',
	});
	expect((await refreshRest('alpha'))?.mode).toBe('wake-requested');
	expect((await readRest('alpha'))?.reason).toBe('Unread mail needs attention');
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(1);
});
