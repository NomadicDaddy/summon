import { expect, test } from 'bun:test';

import type { TerminalProcess } from '../src/desktop/team.ts';
import type { TeamAgent } from '../src/desktop/types.ts';

import { initializeActivity } from '../src/agent-activity.ts';
import { startClaudeTurnBridge } from '../src/claude-turn-bridge.ts';
import { claudeNoticeAllowed, claudeTurn } from '../src/claude-turn-state.ts';
import { inputToOwnedTerminal } from '../src/desktop/owned-terminal-input.ts';
import { assertTerminalDraftClear, terminalDraft } from '../src/desktop/terminal-draft.ts';
import { markReady, saveDelivery } from '../src/mail-session.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

for (const terminalNotices of [false, true]) {
	test.each(['empty-enter', 'human-submit', 'backspace'] as const)(
		`Claude ${terminalNotices ? 'terminal' : 'channel'} notice path handles %s conservatively`,
		async (input) => {
			const fixture = await mailHarness();
			const previousHome = process.env.SUMMON_HOME;
			const previousNonce = process.env.SUMMON_NONCE;
			const nonce = 'channel-input';
			process.env.SUMMON_HOME = fixture.records;
			process.env.SUMMON_NONCE = nonce;
			const bridge = await startClaudeTurnBridge('alpha', nonce, 'exact');
			try {
				await initializeActivity('alpha', nonce);
				await saveDelivery('alpha', {
					nonce,
					thread: 'exact',
					pid: process.pid,
					state: 'unconfirmed',
					reason: '',
				});
				await markReady('alpha', nonce);
				let sequence = 0;
				async function observe(kind: string, turn: string | null = null, draft = false) {
					const response = await fetch(bridge.env.SUMMON_CLAUDE_TURN_URL, {
						method: 'POST',
						headers: { authorization: `Bearer ${bridge.env.SUMMON_CLAUDE_TURN_KEY}` },
						body: JSON.stringify({
							session: 'exact',
							epoch: 1,
							sequence: ++sequence,
							kind,
							turn,
							draft,
							completed: kind === 'complete',
						}),
					});
					expect(response.status).toBe(204);
				}
				await observe('attach');
				await observe('start', 'previous');
				await observe('complete', 'previous');
				const generation = (await claudeTurn('alpha', nonce))?.generation;
				const writes: string[] = [];
				const pty: TerminalProcess = {
					pid: process.pid,
					onData: () => ({ dispose: () => {} }),
					onExit: () => ({ dispose: () => {} }),
					resize: () => {},
					kill: () => {},
					write: (data) => writes.push(String(data)),
				};
				const agent: TeamAgent = {
					slug: 'alpha',
					name: 'Alpha',
					cwd: '.',
					provider: 'claude',
					status: 'running',
				};
				const session = { agent, pty, terminalNotices };
				if (input !== 'empty-enter')
					await inputToOwnedTerminal('alpha', 'x', true, () => session);
				await inputToOwnedTerminal(
					'alpha',
					input === 'backspace' ? '\u007f' : '\r',
					true,
					() => session,
				);
				if (input === 'backspace') {
					await observe('draft');
					expect(terminalDraft(pty).draft).toBe(true);
					expect(() => assertTerminalDraftClear(pty)).toThrow('human input draft');
					expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
				} else {
					expect(terminalDraft(pty).draft).toBe(false);
					expect((await claudeTurn('alpha', nonce))?.phase).toBe(
						terminalNotices ? 'busy' : 'idle',
					);
					expect((await claudeTurn('alpha', nonce))?.generation).toBe(
						(generation ?? 0) + (terminalNotices ? 1 : 0),
					);
					expect(await claudeNoticeAllowed('alpha', nonce)).toBe(!terminalNotices);
				}
				if (input === 'human-submit') {
					await observe('submit', null, true);
					expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
					await observe('start', 'new');
					await observe('complete', 'new');
					expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
				}
				expect(writes).toEqual(
					input === 'empty-enter'
						? ['\r']
						: ['x', input === 'backspace' ? '\u007f' : '\r'],
				);
			} finally {
				await bridge.stop();
				if (previousHome === undefined) delete process.env.SUMMON_HOME;
				else process.env.SUMMON_HOME = previousHome;
				if (previousNonce === undefined) delete process.env.SUMMON_NONCE;
				else process.env.SUMMON_NONCE = previousNonce;
				await fixture.dispose();
			}
		},
	);
}
