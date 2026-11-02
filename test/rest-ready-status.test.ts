import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity, readActivity } from '../src/agent-activity.ts';
import { createBoardItem } from '../src/board.ts';
import { setHibernation } from '../src/hibernation.ts';
import { sendHuman } from '../src/local-room-access.ts';
import { sendMessage } from '../src/mailbox.ts';
import { readRest, refreshRest, restSuppressed, stopForRest } from '../src/rest.ts';
import { createSchedule, listSchedules } from '../src/schedules.ts';
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

async function asProvider(provider: (typeof providers)[number]): Promise<void> {
	const record = await loadAgent('alpha');
	if (!record) throw new Error('Missing fixture member');
	record.provider = provider;
	await saveAgent('alpha', record);
	// The launch phase records the provider; setting a status removes it.
	await initializeActivity('alpha', 'test-launch', provider);
}

const status = async (state: string, text: string) =>
	expect((await fixture.run(['--status', state, text], 'alpha')).code).toBe(0);

for (const provider of providers) {
	test(`${provider}: rest ready from busy sets idle Ready and confirms rest in one command`, async () => {
		await asProvider(provider);
		await status('busy', 'Working on something');
		const result = await fixture.run(['--rest', 'ready'], 'alpha');
		expect(result.code).toBe(0);
		expect(result.out).toContain('Ready to rest confirmed.');
		const activity = await readActivity('alpha');
		expect(activity).toMatchObject({ state: 'idle', workingOn: 'Ready', nonce: 'test-launch' });
		expect(activity?.launch).toBeUndefined();
		expect((await readRest('alpha'))?.mode).toBe('ready');
	});

	test(`${provider}: rest ready preserves a human wait through refresh and rejects a later changed wait`, async () => {
		await asProvider(provider);
		await status('needs-user', 'Approval needed');
		const before = await fixture.read('runtime/alpha/activity.json');
		const result = await fixture.run(['--rest', 'ready'], 'alpha');
		expect(result.code).toBe(0);
		expect(await fixture.read('runtime/alpha/activity.json')).toBe(before);
		const id = (await readRest('alpha'))?.id;
		expect((await refreshRest('alpha'))?.mode).toBe('ready');
		expect(await restSuppressed('alpha')).toBe(true);
		expect(await fixture.read('runtime/alpha/activity.json')).toBe(before);
		expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
		expect((await readRest('alpha'))?.id).toBe(id);
		await status('needs-user', 'Second approval');
		expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
		const second = (await readRest('alpha'))?.id;
		expect(second).not.toBe(id);
		await status('needs-user', 'A different approval is needed');
		expect((await refreshRest('alpha'))?.mode).toBe('wake-requested');
		expect(await restSuppressed('alpha')).toBe(false);
		expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
		expect((await readRest('alpha'))?.id).not.toBe(id);
		expect((await readRest('alpha'))?.id).not.toBe(second);
		const confirmed = await readRest('alpha');
		if (!confirmed) throw new Error('Missing explicit confirmation');
		const waiting = await fixture.read('runtime/alpha/activity.json');
		if (provider === 'codex') await bindIdleCodex(fixture.records, 'alpha', 'test-launch');
		await stopForRest('alpha', confirmed.id, () => Promise.resolve(), provider);
		expect((await readRest('alpha'))?.mode).toBe('stopped');
		expect(await fixture.read('runtime/alpha/activity.json')).toBe(waiting);
		await status('needs-user', 'New approval after the fixture stop');
		const changedAfterStop = await fixture.read('runtime/alpha/activity.json');
		expect(await refreshRest('alpha')).toMatchObject({ mode: 'wake-requested', resume: true });
		expect(await restSuppressed('alpha')).toBe(false);
		expect(await fixture.read('runtime/alpha/activity.json')).toBe(changedAfterStop);
	});

	test(`${provider}: an evidence refusal leaves the caller's status as it was`, async () => {
		await asProvider(provider);
		await sendMessage('beta', 'alpha', 'New evidence needs your review.', { kind: 'request' });
		for (const state of ['busy', 'needs-user']) {
			await status(state, 'Unchanged status while unread work remains');
			const before = await fixture.read('runtime/alpha/activity.json');
			const result = await fixture.run(['--rest', 'ready'], 'alpha');
			expect(result.code).toBe(1);
			expect(result.error).toContain('Cannot confirm rest: Unread mail needs attention');
			expect(await fixture.read('runtime/alpha/activity.json')).toBe(before);
			expect(await readRest('alpha')).toBeUndefined();
		}
	});

	for (const guard of ['doing', 'room', 'schedule'] as const) {
		test(`${provider}: a human wait still refuses rest for ${guard} evidence`, async () => {
			await asProvider(provider);
			await status('needs-user', 'Approval needed');
			if (guard === 'doing')
				await createBoardItem({ title: 'Active task', owner: 'alpha', state: 'doing' });
			else if (guard === 'room') await sendHuman('@alpha new addressed work');
			else {
				await createSchedule({
					owner: 'alpha',
					title: 'Due work',
					prompt: 'Fixture',
					everyMinutes: 1,
				});
				const schedules = await listSchedules();
				const schedule = schedules.schedules[0];
				if (!schedule) throw new Error('Missing fixture schedule');
				schedule.nextDueAt = 0;
				await writeFile(
					join(fixture.records, 'schedules/state.json'),
					JSON.stringify(schedules),
				);
			}
			const before = await fixture.read('runtime/alpha/activity.json');
			const result = await fixture.run(['--rest', 'ready'], 'alpha');
			expect(result.code).toBe(1);
			const expected =
				guard === 'doing'
					? 'Doing cards need attention'
					: guard === 'room'
						? 'Room message #'
						: 'Scheduled work ';
			expect(result.error).toContain(expected);
			expect(await fixture.read('runtime/alpha/activity.json')).toBe(before);
			expect(await readRest('alpha')).toBeUndefined();
		});
	}
}

test('a separate status idle Ready first stays harmless', async () => {
	await asProvider('claude');
	await status('idle', 'Ready');
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
	expect(await readActivity('alpha')).toMatchObject({ state: 'idle', workingOn: 'Ready' });
	expect((await readRest('alpha'))?.mode).toBe('ready');
});

test('another launch cannot set this launch status through rest ready', async () => {
	await initializeActivity('alpha', 'other-launch');
	const before = await fixture.read('runtime/alpha/activity.json');
	const result = await fixture.run(['--rest', 'ready'], 'alpha');
	expect(result.code).toBe(1);
	expect(result.error).toContain('Activity belongs to another launch');
	expect(await fixture.read('runtime/alpha/activity.json')).toBe(before);
	expect(await readRest('alpha')).toBeUndefined();
});

test('hibernation takes precedence and leaves the status alone', async () => {
	await asProvider('claude');
	await status('busy', 'Working on something');
	await setHibernation('alpha', true);
	const before = await fixture.read('runtime/alpha/activity.json');
	const result = await fixture.run(['--rest', 'ready'], 'alpha');
	expect(result.code).toBe(1);
	expect(result.error).toContain('Hibernation takes precedence over rest.');
	expect(await fixture.read('runtime/alpha/activity.json')).toBe(before);
});

test('rest cancel and rest status do not touch the status', async () => {
	await asProvider('claude');
	await status('busy', 'Working on something');
	const before = await fixture.read('runtime/alpha/activity.json');
	expect((await fixture.run(['--rest', 'status'], 'alpha')).code).toBe(0);
	expect((await fixture.run(['--rest', 'cancel'], 'alpha')).code).toBe(0);
	expect(await fixture.read('runtime/alpha/activity.json')).toBe(before);
});
