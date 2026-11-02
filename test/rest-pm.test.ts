import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { setCommunicationPause } from '../src/communication-state.ts';
import { startMailWatcher } from '../src/mail-watcher.ts';
import { pendingMessages, sendMessage } from '../src/mailbox.ts';
import { readRest } from '../src/rest.ts';
import { loadAgent, saveAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let stop: (() => Promise<void>) | undefined;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeActivity('alpha', 'test-launch');
	await initializeActivity('beta', 'test-launch');
	const pm = await loadAgent('beta');
	if (!pm) throw new Error('Missing fixture PM');
	pm.memberType = 'pm';
	await saveAgent('beta', pm);
});
afterEach(async () => {
	await stop?.();
	stop = undefined;
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

async function waitUntil(predicate: () => boolean): Promise<void> {
	const until = Date.now() + 8000;
	while (!predicate()) {
		if (Date.now() >= until) throw new Error('Expected receiver notice did not arrive');
		await Bun.sleep(20);
	}
}

test('PM retains readiness without another wake after an outstanding unread work notice', async () => {
	const notices: string[] = [];
	await writeFile(join(fixture.records, 'runtime/beta/test-launch.ready'), 'test-launch');
	stop = await startMailWatcher('beta', 'test-launch', (text) => {
		notices.push(text);
		return Promise.resolve();
	});
	await sendMessage('alpha', 'beta', 'Earlier unrelated request');
	await waitUntil(() => notices.some((text) => text.includes('1 new mailbox event')));
	const result = await fixture.run(['--rest', 'ready'], 'alpha');
	expect(result.code).toBe(0);
	const id = (await readRest('alpha'))?.id;
	expect(await pendingMessages('beta')).toHaveLength(1);
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
	expect((await readRest('alpha'))?.id).toBe(id);
	expect(await pendingMessages('beta')).toHaveLength(1);
	await Bun.sleep(2100);
	expect(notices.filter((text) => text.includes('alpha is Zzz/rest-ready'))).toHaveLength(0);
}, 15000);

test('readiness stays discoverable through candidates without mailing a PM or teammate', async () => {
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
	const state = await readRest('alpha');
	if (!state) throw new Error('Missing confirmation');
	const candidates = await fixture.run(['--rest', 'candidates']);
	expect(candidates.code).toBe(0);
	expect(JSON.parse(candidates.out)).toEqual([{ name: 'alpha', confirmation: state.id }]);
	expect(await pendingMessages('beta')).toEqual([]);
	expect((await fixture.run(['--rest', 'cancel'], 'alpha')).code).toBe(0);
	expect((await fixture.run(['--rest', 'candidates'])).out.trim()).toBe('[]');
	const pm = await loadAgent('beta');
	if (!pm) throw new Error('Missing fixture PM');
	pm.memberType = 'teammate';
	await saveAgent('beta', pm);
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
	expect(await pendingMessages('beta')).toHaveLength(0);
});

test('local readiness under halt succeeds without a mail send or retry', async () => {
	await setCommunicationPause(true);
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
	const id = (await readRest('alpha'))?.id;
	expect(id).toBeDefined();
	expect(await pendingMessages('beta')).toHaveLength(0);
	await setCommunicationPause(false);
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
	expect((await readRest('alpha'))?.id).toBe(id);
	expect(await pendingMessages('beta')).toHaveLength(0);
});
