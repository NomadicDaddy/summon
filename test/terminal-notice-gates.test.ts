import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { setCommunicationPause } from '../src/communication-state.ts';
import { claudeNoticeSender, recordClaudeInput } from '../src/desktop/claude-terminal-input.ts';
import { queueMentionWake, readPendingMentionWake } from '../src/desktop/mention-wakes.ts';
import { nudgeRest } from '../src/desktop/rest-nudge.ts';
import { Team } from '../src/desktop/team.ts';
import { assertTerminalDraftClear } from '../src/desktop/terminal-draft.ts';
import { saveHeadDown, sessionHeartbeat } from '../src/head-down-model.ts';
import { setHibernation } from '../src/hibernation.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { pendingMessages } from '../src/mailbox.ts';
import { NotificationNotSentError } from '../src/notification-delivery.ts';
import { saveOperatorView } from '../src/operator-view.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { bindIdleTurn } from './fixtures/provider-idle.ts';
import { attachFixtureReceiver, waitForNotice } from './fixtures/wake-team.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const originalHome = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeActivity('alpha', 'test-launch');
});
afterEach(async () => {
	if (originalHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = originalHome;
	await fixture.dispose();
});

async function harness(provider: 'kilo' | 'claude' | 'grok') {
	await writeFile(
		join(fixture.records, 'alpha.json'),
		JSON.stringify(newRecord('alpha', fixture.root, provider)),
	);
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
	await team.start('alpha', false);
	return { team, inputs };
}

test.each(['\u0015', '\u0003'])(
	'Grok human clear %j releases its draft, while reports and single Escape preserve it',
	async (clear) => {
		const h = await harness('grok');
		const pty = h.team.sessions.get('alpha')?.pty;
		if (!pty) throw new Error('Missing fixture terminal.');
		await h.team.input('alpha', 'draft');
		await h.team.input('alpha', clear, false);
		await h.team.input('alpha', '\u001b');
		expect(() => assertTerminalDraftClear(pty)).toThrow('human input draft');
		await h.team.input('alpha', `pasted${clear}`);
		expect(() => assertTerminalDraftClear(pty)).toThrow('human input draft');
		await h.team.input('alpha', clear);
		expect(() => assertTerminalDraftClear(pty)).not.toThrow();
		expect(h.inputs).toEqual(['draft', clear, '\u001b', `pasted${clear}`, clear]);
	},
);

test('Kilo rest nudge retains its episode while a human draft or pasted CR waits', async () => {
	const h = await harness('kilo');
	const nonce = h.team.sessions.get('alpha')?.launch.nonce;
	if (!nonce) throw new Error('Missing fixture launch');
	await initializeActivity('alpha', nonce);
	await bindIdleTurn(fixture.records, 'kilo', 'alpha', nonce);
	const now = Date.now() + 11 * 60000;
	await h.team.input('alpha', 'human pasted text\r');
	const error: unknown = await nudgeRest(h.team, 'alpha', now).catch((error: unknown) => error);
	expect(error).toBeInstanceOf(NotificationNotSentError);
	expect(await pendingMessages('alpha')).toHaveLength(0);
	expect(await Bun.file(join(fixture.records, 'runtime/alpha/rest-nudge')).exists()).toBe(false);
	expect(h.inputs).toEqual(['human pasted text\r']);
	await h.team.input('alpha', '\r');
	await h.team.input('alpha', '\u001b[1;1R', false);
	// The Enter submitted the human's text, so Kilo's turn is busy until it completes.
	const turnPath = join(fixture.records, 'runtime/alpha', `${nonce}.kilo-turn`);
	const turn = (await Bun.file(turnPath).json()) as Record<string, unknown>;
	expect(turn.phase).toBe('busy');
	await writeFile(turnPath, JSON.stringify({ ...turn, phase: 'idle' }));
	await nudgeRest(h.team, 'alpha', now);
	await nudgeRest(h.team, 'alpha', now);
	expect(await pendingMessages('alpha')).toHaveLength(1);
	expect(h.inputs).toHaveLength(3);
	// Attach only after the event exists. Preserve its launch and idle episode rather
	// than resetting activity or racing an earlier bootstrap readiness submission.
	const stop = await attachFixtureReceiver(h.team, 'alpha', nonce, true);
	try {
		await waitForNotice(h.inputs, 'mailbox event');
		expect(h.inputs).toHaveLength(4);
	} finally {
		await stop();
	}
});

test('Claude pasted CR remains a draft until a separate Enter', async () => {
	const h = await harness('claude');
	const pty = h.team.sessions.get('alpha')?.pty;
	if (!pty) throw new Error('Missing fixture terminal.');
	recordClaudeInput(pty, 'human text\r');
	const send = claudeNoticeSender(
		pty,
		() => Promise.resolve(),
		() => Promise.resolve(),
	);
	expect(await send('notice').catch((error: unknown) => error)).toBeInstanceOf(
		NotificationNotSentError,
	);
	expect(h.inputs).toEqual([]);
	recordClaudeInput(pty, '\r');
	await send('notice');
	expect(h.inputs).toHaveLength(2);
});

test('Kilo pending mention stays durable behind a draft and submits once after separate Enter', async () => {
	const h = await harness('kilo');
	const event = await appendLocalEvent({
		sender: { kind: 'user', id: 'operator' },
		text: '@alpha read this',
		replyTo: null,
		source: 'local',
	});
	await queueMentionWake('alpha', event.id);
	await h.team.input('alpha', 'draft');
	await h.team.flushPendingMentionWakes();
	await h.team.flushPendingMentionWakes();
	expect(h.inputs).toEqual(['draft']);
	expect((await readPendingMentionWake('alpha'))?.notifiedNonce).toBeUndefined();
	await h.team.input('alpha', '\r');
	await h.team.flushPendingMentionWakes();
	await h.team.flushPendingMentionWakes();
	const stop = await attachFixtureReceiver(h.team, 'alpha');
	try {
		await waitForNotice(h.inputs, `through ${event.id}`);
		expect(h.inputs).toHaveLength(3);
		expect((await readPendingMentionWake('alpha'))?.notifiedNonce).toBeUndefined();
		expect((await readPendingMentionWake('alpha'))?.through).toBe(event.id);
	} finally {
		await stop();
	}
});

for (const gate of ['halt', 'viewing', 'hibernation', 'head-down'] as const) {
	test(`Kilo rest nudge waits through ${gate} without consuming its idle episode`, async () => {
		const h = await harness('kilo');
		// The nudge needs idle activity from the session's own launch (tool-aware-idle-nudge).
		const nonce = h.team.sessions.get('alpha')?.launch.nonce;
		if (!nonce) throw new Error('Missing fixture launch');
		await initializeActivity('alpha', nonce);
		await bindIdleTurn(fixture.records, 'kilo', 'alpha', nonce);
		if (gate === 'halt') await setCommunicationPause(true);
		else if (gate === 'viewing') await saveOperatorView('alpha');
		else if (gate === 'hibernation') await setHibernation('alpha', true);
		else {
			await saveHeadDown('alpha', {
				id: randomUUID(),
				nonce,
				phase: 'active',
				goal: 'Fixture goal',
				completion: 'Fixture completion',
				questionId: 1,
				approvedBy: 'operator',
			});
			await sessionHeartbeat('alpha', nonce);
		}
		const now = Date.now() + 11 * 60000;
		await nudgeRest(h.team, 'alpha', now);
		expect(h.inputs).toEqual([]);
		expect(await pendingMessages('alpha')).toHaveLength(0);
		expect(await Bun.file(join(fixture.records, 'runtime/alpha/rest-nudge')).exists()).toBe(
			false,
		);
		if (gate === 'halt') await setCommunicationPause(false);
		else if (gate === 'viewing') await saveOperatorView('');
		else if (gate === 'hibernation') await setHibernation('alpha', false);
		else
			await saveHeadDown('alpha', {
				id: randomUUID(),
				nonce,
				phase: 'ended',
				goal: 'Fixture goal',
				completion: 'Fixture completion',
				questionId: 1,
			});
		await nudgeRest(h.team, 'alpha', now);
		expect(h.inputs).toHaveLength(0);
		expect(await pendingMessages('alpha')).toHaveLength(1);
	});
}
