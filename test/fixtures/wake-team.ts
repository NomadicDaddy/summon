import type { Team } from '../../src/desktop/team.ts';

import { initializeActivity, readActivity } from '../../src/agent-activity.ts';
import {
	claudeTurn,
	initializeClaudeTurn,
	observeClaudeTurn,
} from '../../src/claude-turn-state.ts';
import {
	stopTerminalReceivers,
	syncTerminalReceivers,
} from '../../src/desktop/terminal-receivers.ts';
import { observeGrokTurn } from '../../src/grok-turn-state.ts';
import {
	initializeKiloTurn,
	kiloStartupSettled,
	kiloStartupSubmitting,
	observeKiloTurn,
} from '../../src/kilo-turn-state.ts';
import { saveDelivery } from '../../src/mail-session.ts';

export async function observeFixtureGrokIdle(
	name: string,
	nonce: string,
	thread: string,
): Promise<void> {
	await Bun.sleep(5);
	await observeGrokTurn(name, nonce, {
		sessionId: thread,
		hook_event_name: 'Notification',
		notificationType: 'idle_prompt',
		timestamp: new Date().toISOString(),
	});
}

/** Explicit native fixture events, never a sidebar status or elapsed-time idle claim. */
export async function observeFixtureClaudeIdle(name: string, nonce: string): Promise<void> {
	const state = await claudeTurn(name, nonce);
	if (!state) throw new Error('Missing fixture Claude observer.');
	let sequence = state.sequence;
	const send = (kind: 'attach' | 'start' | 'complete', turn: string | null) =>
		observeClaudeTurn(name, nonce, state.observer, {
			session: state.thread,
			epoch: state.epoch,
			sequence: ++sequence,
			kind,
			turn,
			completed: kind === 'complete',
			draft: false,
		});
	if (!state.attached) await send('attach', null);
	const turn = `fixture-turn-${sequence + 1}`;
	await send('start', turn);
	await send('complete', turn);
}

export async function attachFixtureReceiver(
	team: Team,
	name: string,
	nonce = 'receiver-fixture',
	preserveActivity = false,
): Promise<() => Promise<void>> {
	if (!preserveActivity) await initializeActivity(name, nonce);
	else if ((await readActivity(name))?.nonce !== nonce)
		throw new Error('Fixture receiver must preserve the existing launch.');
	if (team.sessions.get(name)?.agent.provider === 'claude') {
		await initializeClaudeTurn(name, nonce, 'disposable-thread', 'fixture-observer');
		await observeFixtureClaudeIdle(name, nonce);
	}
	if (team.sessions.get(name)?.agent.provider === 'kilo') {
		await initializeKiloTurn(name, nonce, 'disposable-thread', 'fixture-stream');
		// Like Claude above: a completed, observed startup turn, which Kilo notices now need.
		await kiloStartupSubmitting(name, nonce, 'disposable-thread');
		await kiloStartupSettled(name, nonce, 'disposable-thread', 'accepted');
		for (const type of ['busy', 'idle'])
			await observeKiloTurn(name, nonce, 'fixture-stream', {
				type: 'session.status',
				properties: { sessionID: 'disposable-thread', status: { type } },
			});
	}
	await saveDelivery(name, {
		nonce,
		pid: process.pid,
		state: 'unconfirmed',
		reason: '',
		thread: 'disposable-thread',
	});
	await syncTerminalReceivers(team);
	return () => stopTerminalReceivers(team);
}

export async function waitForNotice(inputs: string[], text: string): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (inputs.some((input) => input.includes(text))) return;
		await Bun.sleep(10);
	}
	throw new Error('Expected owned receiver notice was not observed.');
}
