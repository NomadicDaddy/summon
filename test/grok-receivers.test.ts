import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity, readActivity } from '../src/agent-activity.ts';
import { initializeClaudeTurn } from '../src/claude-turn-state.ts';
import { stopTerminalReceivers, syncTerminalReceivers } from '../src/desktop/terminal-receivers.ts';
import { HIBERNATE_INSTRUCTION } from '../src/hibernation.ts';
import {
	initializeKiloTurn,
	kiloStartupSettled,
	kiloStartupSubmitting,
	observeKiloTurn,
} from '../src/kilo-turn-state.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { deliveryStatus, markReady, saveDelivery } from '../src/mail-session.ts';
import { sendMessage } from '../src/mailbox.ts';
import { saveOperatorView } from '../src/operator-view.ts';
import { newRecord, updateAgentRecord } from '../src/store.ts';
import { wakeDeliveryStatus } from '../src/wake-delivery-store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { terminalHarness as harness } from './fixtures/owned-terminal.ts';
import { observeFixtureClaudeIdle, observeFixtureGrokIdle } from './fixtures/wake-team.ts';

const kiloNative = (type: string) =>
	observeKiloTurn('alpha', 'draft-launch', 'fixture-stream', {
		type: 'session.status',
		properties: { sessionID: 'draft-thread', status: { type } },
	});

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = { home: process.env.SUMMON_HOME, nonce: process.env.SUMMON_NONCE };
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous.home;
	if (previous.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previous.nonce;
	await fixture.dispose();
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const limit = Date.now() + 8000;
	while (!(await predicate()) && Date.now() < limit) await Bun.sleep(20);
	expect(await predicate()).toBe(true);
}

for (const provider of ['grok', 'claude'] as const) {
	test(`owned ${provider} delivers readiness and later work using its provider gate`, async () => {
		const h = harness();
		const status = () => deliveryStatus('alpha', 'grok-fixture');
		const delivery = () => wakeDeliveryStatus('alpha', 'grok-fixture');
		try {
			await writeFile(
				join(fixture.records, 'alpha.json'),
				JSON.stringify(newRecord('alpha', fixture.root, provider)),
			);
			await writeFile(
				join(fixture.records, 'beta.json'),
				JSON.stringify(newRecord('beta', fixture.root, 'claude')),
			);
			await mkdir(join(fixture.records, 'settings'));
			await writeFile(
				join(fixture.records, 'settings/claude-delivery.json'),
				'{"version":1,"mode":"checkpoint"}',
			);
			await h.team.start('alpha', false);
			// A setting change applies to the next launch, not this terminal's captured transport.
			await writeFile(
				join(fixture.records, 'settings/claude-delivery.json'),
				'{"version":1,"mode":"live"}',
			);
			await initializeActivity('alpha', 'grok-fixture');
			await saveDelivery('alpha', {
				nonce: 'grok-fixture',
				pid: process.pid,
				state: 'queued-only',
				reason: '',
				thread: 'disposable-grok-thread',
			});
			await saveOperatorView('alpha');
			if (provider === 'claude')
				await initializeClaudeTurn(
					'alpha',
					'grok-fixture',
					'disposable-grok-thread',
					'fixture-observer',
				);
			await syncTerminalReceivers(h.team);
			await Bun.sleep(100);
			expect(h.inputs).toEqual([]);
			await saveOperatorView('');
			if (provider === 'claude') await observeFixtureClaudeIdle('alpha', 'grok-fixture');
			await waitFor(() => h.inputs.some((text) => text.includes('--mail ready')));
			process.env.SUMMON_NONCE = 'grok-fixture';
			await markReady('alpha', 'grok-fixture');
			if (provider === 'grok')
				await observeFixtureGrokIdle('alpha', 'grok-fixture', 'disposable-grok-thread');
			else await observeFixtureClaudeIdle('alpha', 'grok-fixture');
			await sendMessage('beta', 'alpha', 'Later peer handoff');
			await waitFor(() => h.inputs.some((text) => text.includes('mailbox event')));
			await waitFor(async () => (await delivery()).latest?.state === 'provider-submitted');
			await waitFor(async () => (await status()).reason.startsWith('Notices held'));
			expect((await status()).state).toBe('queued-only');
			if (provider === 'grok')
				await observeFixtureGrokIdle('alpha', 'grok-fixture', 'disposable-grok-thread');
			else await observeFixtureClaudeIdle('alpha', 'grok-fixture');
			await waitFor(async () => (await status()).state === 'live');
			await appendLocalEvent({
				sender: { kind: 'agent', id: 'beta' },
				text: '@alpha later handoff',
				replyTo: null,
				source: 'local',
			});
			await waitFor(() => h.inputs.some((text) => text.includes('summon room through')));
			if (provider === 'claude') {
				await waitFor(() => h.inputs.at(-1) === '\r');
				expect(h.inputs.filter((text) => text.startsWith('\u001b[200~'))).toHaveLength(3);
			} else expect(h.inputs.every((text) => text.endsWith('\r'))).toBe(true);
			const count = h.inputs.length;
			await syncTerminalReceivers(h.team);
			await Bun.sleep(2200);
			expect(h.inputs).toHaveLength(count);
			await stopTerminalReceivers(h.team);
			await sendMessage('beta', 'alpha', 'After receiver shutdown');
			await Bun.sleep(2200);
			expect(h.inputs).toHaveLength(count);
		} finally {
			await stopTerminalReceivers(h.team);
		}
	}, 20000);
}

test('live Claude does not attach a competing terminal receiver', async () => {
	const h = harness();
	try {
		await h.team.start('alpha', false);
		await initializeActivity('alpha', 'live-claude');
		await saveDelivery('alpha', {
			nonce: 'live-claude',
			pid: process.pid,
			state: 'queued-only',
			reason: '',
			thread: 'live-thread',
		});
		await syncTerminalReceivers(h.team);
		await Bun.sleep(100);
		expect(h.inputs).toEqual([]);
		expect(
			await Bun.file(join(fixture.records, 'runtime/alpha/receiver/owner.json')).exists(),
		).toBe(false);
	} finally {
		await stopTerminalReceivers(h.team);
	}
});

test.each(['claude', 'grok', 'kilo'] as const)(
	'owned %s waits for a human draft before submitting readiness',
	async (provider) => {
		const h = harness();
		try {
			await writeFile(
				join(fixture.records, 'alpha.json'),
				JSON.stringify(newRecord('alpha', fixture.root, provider)),
			);
			await mkdir(join(fixture.records, 'settings'));
			await writeFile(
				join(fixture.records, 'settings/claude-delivery.json'),
				'{"version":1,"mode":"checkpoint"}',
			);
			await h.team.start('alpha', false);
			await h.team.input('alpha', 'unfinished human text');
			await initializeActivity('alpha', 'draft-launch');
			await saveDelivery('alpha', {
				nonce: 'draft-launch',
				pid: process.pid,
				state: 'queued-only',
				reason: '',
				thread: 'draft-thread',
			});
			if (provider === 'claude')
				await initializeClaudeTurn(
					'alpha',
					'draft-launch',
					'draft-thread',
					'fixture-observer',
				);
			// Kilo readiness also waits for its startup turn (Phillip #22057); complete it here, so
			// only the human draft holds readiness back.
			if (provider === 'kilo') {
				await initializeKiloTurn('alpha', 'draft-launch', 'draft-thread', 'fixture-stream');
				await kiloStartupSubmitting('alpha', 'draft-launch', 'draft-thread');
				await kiloStartupSettled('alpha', 'draft-launch', 'draft-thread', 'accepted');
				await kiloNative('busy');
				await kiloNative('idle');
			}
			await syncTerminalReceivers(h.team);
			await Bun.sleep(100);
			expect(h.inputs).toEqual(['unfinished human text']);
			await h.team.input('alpha', '\r');
			if (provider === 'claude') await observeFixtureClaudeIdle('alpha', 'draft-launch');
			// Enter submits the human's turn; its native completion reopens delivery.
			if (provider === 'kilo') {
				await kiloNative('busy');
				await kiloNative('idle');
			}
			await waitFor(() => h.inputs.some((text) => text.includes('--mail ready')));
			if (provider === 'claude') await waitFor(() => h.inputs.at(-1) === '\r');
			expect(h.inputs).toHaveLength(provider === 'claude' ? 4 : 3);
			if (provider === 'claude') expect(h.inputs[2]?.startsWith('\u001b[200~')).toBe(true);
		} finally {
			await stopTerminalReceivers(h.team);
		}
	},
	15000,
);

test('receiver skips stale launch activity for every provider', async () => {
	for (const provider of ['grok', 'claude', 'codex', 'kilo'] as const) {
		const h = harness();
		try {
			await writeFile(
				join(fixture.records, 'alpha.json'),
				JSON.stringify(newRecord('alpha', fixture.root, provider)),
			);
			await initializeActivity('alpha', 'old-launch');
			await Bun.sleep(5);
			await h.team.start('alpha', false);
			await syncTerminalReceivers(h.team);
			expect(h.inputs).toEqual([]);
		} finally {
			await stopTerminalReceivers(h.team);
		}
	}
});

test('shutdown racing receiver discovery never leaves a late watcher attached', async () => {
	const h = harness();
	await writeFile(
		join(fixture.records, 'alpha.json'),
		JSON.stringify(newRecord('alpha', fixture.root, 'grok')),
	);
	await h.team.start('alpha', false);
	await initializeActivity('alpha', 'new-launch');
	const discovering = syncTerminalReceivers(h.team);
	h.team.closing = true;
	await stopTerminalReceivers(h.team);
	await discovering;
	await Bun.sleep(100);
	expect(h.inputs).toEqual([]);
});

test.each(['grok', 'kilo'] as const)(
	'%s hibernation uses one launch receiver even when the registration provider changes',
	async (provider) => {
		const h = harness();
		try {
			await writeFile(
				join(fixture.records, 'alpha.json'),
				JSON.stringify(newRecord('alpha', fixture.root, provider)),
			);
			await h.team.start('alpha', false);
			await h.team.hibernate('alpha', true);
			expect(h.inputs).toEqual([]);
			await initializeActivity('alpha', 'control-launch');
			const activity = await readActivity('alpha');
			await writeFile(
				join(fixture.records, 'runtime/alpha/activity.json'),
				JSON.stringify({ ...activity, state: 'busy' }),
			);
			await saveDelivery('alpha', {
				nonce: 'control-launch',
				pid: process.pid,
				state: 'queued-only',
				reason: '',
				thread: 'disposable-control-thread',
			});
			await syncTerminalReceivers(h.team);
			await waitFor(() => h.inputs.includes(`${HIBERNATE_INSTRUCTION}\r`));
			// Changing future launches to Kilo must not attach its PTY route to this running Grok.
			await updateAgentRecord('alpha', (record) => {
				record.provider = provider === 'grok' ? 'kilo' : 'grok';
			});
			await h.team.syncHibernation();
			expect(h.inputs.filter((text) => text.includes(HIBERNATE_INSTRUCTION))).toHaveLength(1);
			await h.team.hibernate('alpha', false);
			await waitFor(() => h.inputs.some((text) => text.includes('has unhibernated')));
			await h.team.syncHibernation();
			await Bun.sleep(2200);
			expect(h.inputs.filter((text) => text.includes('has unhibernated'))).toHaveLength(1);
		} finally {
			await stopTerminalReceivers(h.team);
		}
	},
	15000,
);
