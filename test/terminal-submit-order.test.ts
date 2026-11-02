import { expect, mock, test } from 'bun:test';

import type { TerminalProcess } from '../src/desktop/team.ts';
import type { TeamAgent } from '../src/desktop/types.ts';

let readStarted: () => void = () => {};
let readFinished: Promise<void> = Promise.resolve();
await mock.module('../src/agent-activity.ts', () => ({
	readActivity: async () => {
		readStarted();
		await readFinished;
		return undefined;
	},
}));
await mock.module('../src/hibernation.ts', () => ({ isHibernated: () => Promise.resolve(false) }));
const { inputToOwnedTerminal } = await import('../src/desktop/owned-terminal-input.ts');
const { assertTerminalDraftClear, recordTerminalDraft, terminalDraft } =
	await import('../src/desktop/terminal-draft.ts');

function fixture(provider: 'grok' | 'kilo', behavior: 'normal' | 'typing' | 'fail') {
	const writes: string[] = [];
	const entered = Promise.withResolvers<undefined>();
	const release = Promise.withResolvers<undefined>();
	readStarted = () => entered.resolve(undefined);
	readFinished = release.promise;
	const pty: TerminalProcess = {
		pid: process.pid,
		onData: () => ({ dispose: () => {} }),
		onExit: () => ({ dispose: () => {} }),
		resize: () => {},
		kill: () => {},
		write: (text) => {
			expect(() => assertTerminalDraftClear(pty)).toThrow('human input draft');
			if (behavior === 'fail') throw new Error('Uncertain human submission.');
			writes.push(String(text));
			if (behavior === 'typing') recordTerminalDraft(pty, 'newer draft', true);
		},
	};
	const agent: TeamAgent = {
		slug: 'alpha',
		name: 'Alpha',
		cwd: '.',
		provider,
		status: 'running',
	};
	const session = { agent, pty, terminalNotices: true };
	return { entered, release, writes, pty, session };
}

for (const provider of ['grok', 'kilo'] as const) {
	test.each([false, true])(
		`${provider} Enter blocks delivery through submission (draft %s)`,
		async (draft) => {
			const h = fixture(provider, 'normal');
			if (draft) recordTerminalDraft(h.pty, 'human draft', true);
			expect(terminalDraft(h.pty).draft).toBe(draft);
			const input = inputToOwnedTerminal('alpha', '\r', true, () => h.session);
			await h.entered.promise;
			expect(h.writes).toEqual([]);
			expect(() => assertTerminalDraftClear(h.pty)).toThrow('human input draft');
			h.release.resolve(undefined);
			await input;
			expect(h.writes).toEqual(['\r']);
			expect(() => assertTerminalDraftClear(h.pty)).not.toThrow();
		},
	);
	for (const behavior of ['typing', 'fail'] as const) {
		test(`${provider} retains its draft after ${behavior} during submission`, async () => {
			const h = fixture(provider, behavior);
			const input = inputToOwnedTerminal('alpha', '\r', true, () => h.session);
			await h.entered.promise;
			h.release.resolve(undefined);
			if (behavior === 'fail') {
				expect(input).rejects.toThrow('Uncertain');
				await input.catch(() => {});
			} else await input;
			expect(terminalDraft(h.pty).draft).toBe(true);
		});
	}
}
