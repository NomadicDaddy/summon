import { beforeEach, expect, mock, test } from 'bun:test';

import type { TerminalProcess } from '../src/desktop/team.ts';

import { saveTerminalDraft, terminalDraft } from '../src/desktop/terminal-draft.ts';
import { NotificationEnterWithheldError } from '../src/notification-delivery.ts';

let result: false | { draft: boolean } = false;
let onRelease: (() => void) | undefined;
let nativeReads = 0;
await mock.module('../src/claude-notice-release.ts', () => ({
	releaseWithheldClaudeNotice: () => {
		onRelease?.();
		return Promise.resolve(result);
	},
}));
// A later snapshot may say empty for an unrelated transition. It must never lend its proof.
await mock.module('../src/claude-turn-state.ts', () => ({
	claudeTurn: () => {
		nativeReads++;
		return Promise.resolve({ draft: false });
	},
}));
const { releaseWithheldNotice } = await import('../src/desktop/claude-withheld-release.ts');
let pty: TerminalProcess;
beforeEach(() => {
	result = false;
	onRelease = undefined;
	nativeReads = 0;
	pty = {
		pid: process.pid,
		onData: () => ({ dispose: () => {} }),
		onExit: () => ({ dispose: () => {} }),
		write: () => {
			throw new Error('A release must never write terminal input.');
		},
		resize: () => {},
		kill: () => {},
	};
	saveTerminalDraft(pty, 4, true);
});
const release = () =>
	releaseWithheldNotice(
		pty,
		'alpha',
		'nonce',
		'token',
		new NotificationEnterWithheldError(new Error('withheld'), 4),
	);

test('a released held draft cannot borrow a later unrelated empty native snapshot', async () => {
	result = { draft: true };
	await release();
	expect(terminalDraft(pty)).toMatchObject({ version: 4, draft: true });
	expect(nativeReads).toBe(0);
});
test('the exact empty release clears only the unchanged own paste mark', async () => {
	result = { draft: false };
	await release();
	expect(terminalDraft(pty)).toMatchObject({ version: 4, draft: false });
	expect(nativeReads).toBe(0);
});
test('human input during release keeps its newer pane mark', async () => {
	result = { draft: false };
	onRelease = () => saveTerminalDraft(pty, 5, true);
	await release();
	expect(terminalDraft(pty)).toMatchObject({ version: 5, draft: true });
});
test('a refused or failed release keeps the original pane mark', async () => {
	await release();
	expect(terminalDraft(pty).draft).toBe(true);
	onRelease = () => {
		throw new Error('release failed');
	};
	await release();
	expect(terminalDraft(pty).draft).toBe(true);
});
