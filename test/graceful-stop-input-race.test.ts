import { expect, mock, test } from 'bun:test';

import type { TerminalProcess } from '../src/desktop/team.ts';
import type { TeamAgent } from '../src/desktop/types.ts';

let entered = Promise.withResolvers<undefined>();
let release = Promise.withResolvers<undefined>();
const submitting = () => {
	entered.resolve(undefined);
	return release.promise;
};
await mock.module('../src/agent-activity.ts', () => ({
	readActivity: () => Promise.resolve({ nonce: 'fixture' }),
}));
await mock.module('../src/hibernation.ts', () => ({ isHibernated: () => Promise.resolve(false) }));
await mock.module('../src/claude-turn-state.ts', () => ({ claudeInputSubmitted: submitting }));
await mock.module('../src/claude-notice-release.ts', () => ({
	spendClaudeRelease: () => Promise.resolve(),
}));
await mock.module('../src/grok-turn-state.ts', () => ({ grokInputSubmitted: submitting }));
await mock.module('../src/kilo-turn-state.ts', () => ({ kiloInputSubmitted: submitting }));
const { inputToOwnedTerminal } = await import('../src/desktop/owned-terminal-input.ts');

for (const provider of ['claude', 'grok', 'kilo'] as const) {
	test(`${provider}: a pending human Enter cannot write after Stop starts`, async () => {
		entered = Promise.withResolvers<undefined>();
		release = Promise.withResolvers<undefined>();
		const writes: string[] = [];
		const pty: TerminalProcess = {
			pid: 1,
			onData: () => ({ dispose: () => {} }),
			onExit: () => ({ dispose: () => {} }),
			write: (data) => {
				writes.push(String(data));
			},
			resize: () => {},
			kill: () => {},
		};
		const agent: TeamAgent = {
			slug: 'alpha',
			name: 'Alpha',
			cwd: '.',
			provider,
			status: 'running',
		};
		const session = { agent, pty, terminalNotices: true, stopRequested: false };
		const input = inputToOwnedTerminal('alpha', '\r', true, () => session);
		await entered.promise;
		session.stopRequested = true;
		release.resolve(undefined);
		await input;
		expect(writes).toEqual([]);
	});
}
