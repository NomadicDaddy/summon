import { deepEqual, equal } from 'node:assert/strict';

import type { TerminalProcess } from '../../src/desktop/team.ts';

import { claudeNoticeSender } from '../../src/desktop/claude-terminal-input.ts';

equal(Reflect.has(globalThis, 'Bun'), false);
const writes: string[] = [];
const pty: TerminalProcess = {
	pid: process.pid,
	onData: () => ({ dispose: () => {} }),
	onExit: () => ({ dispose: () => {} }),
	write: (data) => {
		writes.push(String(data));
	},
	resize: () => {},
	kill: () => {},
};
const send = claudeNoticeSender(pty, () => Promise.resolve());
await Promise.all([send('room'), send('mail')]);
deepEqual(writes, ['\u001b[200~room\u001b[201~', '\r', '\u001b[200~mail\u001b[201~', '\r']);
console.log('Electron notice submission passed without Bun.');
