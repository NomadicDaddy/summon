import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity, readActivity } from '../src/agent-activity.ts';
import { createBoardItem, readBoard, updateBoardItem } from '../src/board.ts';
import { sendMessage } from '../src/mailbox.ts';
import { readRest, refreshRest, stopForRest } from '../src/rest.ts';
import { createSchedule, dispatchSchedules, listSchedules } from '../src/schedules.ts';
import { loadAgent, providers, saveAgent } from '../src/store.ts';
import { bindIdleCodex } from './fixtures/codex-idle.ts';
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

async function prepare(provider: (typeof providers)[number], count = 1) {
	const record = await loadAgent('alpha');
	if (!record) throw new Error('Missing fixture member');
	record.provider = provider;
	await saveAgent('alpha', record);
	await initializeActivity('alpha', 'test-launch', provider);
	expect((await fixture.run(['--status', 'idle', 'Ready'], 'alpha')).code).toBe(0);
	for (let index = 0; index < count; index++)
		await createBoardItem({
			title: `Approval-scoped work ${index + 1}`,
			owner: 'alpha',
			state: 'ready',
			description: 'Only metadata is approved; implementation needs separate user approval.',
		});
}

async function dueSchedule() {
	await createSchedule({
		owner: 'alpha',
		title: 'Fixture duty',
		prompt: 'No-op',
		everyMinutes: 1,
	});
	const state = await listSchedules();
	const schedule = state.schedules[0];
	if (!schedule) throw new Error('Missing fixture schedule');
	schedule.nextDueAt = 0;
	await writeFile(join(fixture.records, 'schedules/state.json'), JSON.stringify(state));
}

for (const provider of providers) {
	test(`${provider}: fourteen Ready approval cards permit explicit rest without changing the cards`, async () => {
		await prepare(provider, 14);
		const before = await readBoard();
		const result = await fixture.run(['--rest', 'ready'], 'alpha');
		expect(result.code).toBe(0);
		expect(result.out).toContain('Ready to rest confirmed.');
		const confirmation = await readRest('alpha');
		expect(confirmation?.mode).toBe('ready');
		expect((await refreshRest('alpha'))?.mode).toBe('ready');
		expect(await readBoard()).toEqual(before);
		if (!confirmation) throw new Error('Missing rest confirmation');
		if (provider === 'codex') await bindIdleCodex(fixture.records, 'alpha', 'test-launch');
		let stopped = false;
		await stopForRest(
			'alpha',
			confirmation.id,
			() => {
				stopped = true;
				return Promise.resolve();
			},
			provider,
		);
		expect(stopped).toBe(true);
		expect((await readRest('alpha'))?.mode).toBe('stopped');
		expect(await readBoard()).toEqual(before);
	});

	test(`${provider}: Doing work still refuses rest alongside Ready cards and preserves status`, async () => {
		await prepare(provider);
		await createBoardItem({ title: 'Active work', owner: 'alpha', state: 'doing' });
		expect((await fixture.run(['--status', 'busy', 'Active work'], 'alpha')).code).toBe(0);
		const before = await readActivity('alpha');
		const result = await fixture.run(['--rest', 'ready'], 'alpha');
		expect(result.code).toBe(1);
		expect(result.error).toContain('Doing cards need attention');
		expect(await readActivity('alpha')).toEqual(before);
		expect(await readRest('alpha')).toBeUndefined();
	});

	test(`${provider}: due schedules still refuse rest alongside Ready cards`, async () => {
		await prepare(provider);
		await dueSchedule();
		const before = await listSchedules();
		const result = await fixture.run(['--rest', 'ready'], 'alpha');
		expect(result.code).toBe(1);
		expect(result.error).toContain('Scheduled work');
		expect(result.error).toContain('is due');
		expect(await listSchedules()).toEqual(before);
		expect(await readRest('alpha')).toBeUndefined();
	});

	// Registration, status, mail and rest CLI handoffs share this integration budget.
	test(`${provider}: read but unfinished scheduled work still refuses rest with Ready cards`, async () => {
		await prepare(provider);
		await dueSchedule();
		await dispatchSchedules(
			() => Promise.resolve(true),
			() => Promise.resolve(),
		);
		const received = await fixture.run(['--mail', 'receive'], 'alpha');
		expect(received.code).toBe(0);
		const before = await listSchedules();
		expect(before.runs[0]?.status).toBe('delivered');
		const result = await fixture.run(['--rest', 'ready'], 'alpha');
		expect(result.code).toBe(1);
		expect(result.error).toContain('Scheduled run');
		expect(result.error).toContain('delivered');
		expect(await listSchedules()).toEqual(before);
		expect(await readRest('alpha')).toBeUndefined();
	}, 15_000);

	test(`${provider}: a Ready card changing to Doing invalidates the old rest confirmation`, async () => {
		await prepare(provider);
		expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
		const card = (await readBoard()).items[0];
		if (!card) throw new Error('Missing fixture card');
		await updateBoardItem(card.id, card.revision, { state: 'doing' });
		expect((await refreshRest('alpha'))?.mode).toBe('wake-requested');
		expect((await readRest('alpha'))?.reason).toBe('Doing cards need attention');
	});

	test(`${provider}: an approval decision still invalidates rest with unchanged Ready cards`, async () => {
		await prepare(provider);
		const message = await sendMessage('beta', 'alpha', 'Proposed work needs approval.');
		for (const args of [
			['--mail', 'read-self', message, '--offset', '0', '--limit', '4096'],
			['--mail', 'confirm', message, 'Hold this proposal for the user.'],
		])
			expect((await fixture.run(args, 'alpha')).code).toBe(0);
		const held = await fixture.run(
			['--mail', 'hold', message, 'Approval required', 'Fixture-only proposed work.'],
			'alpha',
		);
		expect(held.code).toBe(0);
		const { hold } = JSON.parse(held.out) as { hold: { id: string } };
		expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
		const decision = await fixture.run(
			['--mail', 'record-decision', hold.id, 'approve', 'Fixture operator decision'],
			'alpha',
		);
		expect(decision.code).toBe(0);
		expect((await refreshRest('alpha'))?.mode).toBe('wake-requested');
		expect((await readRest('alpha'))?.reason).toBe('Your cards or approval decisions changed');
	});
}
