import { expect, test } from 'bun:test';

import type { TerminalProcess } from '../src/desktop/team.ts';

import { claudeNoticeSender, recordClaudeInput } from '../src/desktop/claude-terminal-input.ts';
import { bindTerminalInput } from '../src/desktop/terminal-input-origin.ts';
import {
	NotificationNotSentError,
	NotificationUnsubmittedError,
} from '../src/notification-delivery.ts';

async function rejection(result: Promise<void>): Promise<string> {
	try {
		await result;
		return 'unexpected success';
	} catch (error: unknown) {
		return error instanceof Error ? error.message : String(error);
	}
}

function fixture() {
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
	return { pty, writes };
}

test('Claude notice submits a separate Enter after closing its multiline paste', async () => {
	const h = fixture();
	const phases: string[] = [];
	const send = claudeNoticeSender(
		h.pty,
		() => {
			phases.push('check');
			return Promise.resolve();
		},
		() => {
			phases.push('wait');
			expect(h.writes).toEqual(['\u001b[200~one\ntwo\u001b[201~']);
			return Promise.resolve();
		},
	);
	await send('one\ntwo');
	expect(h.writes).toEqual(['\u001b[200~one\ntwo\u001b[201~', '\r']);
	expect(phases).toEqual(['check', 'wait', 'check']);
});

test('automatic xterm query replies do not create or recreate a human draft', async () => {
	const h = fixture();
	const send = claudeNoticeSender(
		h.pty,
		() => Promise.resolve(),
		() => Promise.resolve(),
	);
	let emitData: (data: string) => void = () => {};
	bindTerminalInput(
		{
			onKey: () => {},
			onData: (listener) => {
				emitData = listener;
			},
		},
		(data, humanInput) => recordClaudeInput(h.pty, data, humanInput),
	);
	// Observed from installed browser xterm6 onData without any keyboard event.
	const replies = [
		'\u001b[?1;2c',
		'\u001b[0n',
		'\u001b[1;1R',
		'\u001b[?2026;2$y',
		'\u001b]4;0;rgb:2e2e/3434/3636\u001b\\',
		'\u001bP1$r0m\u001b\\',
		'\u001bP1$r2 q\u001b\\',
		'\u001b[<35;49;19M',
		'\u001b[<0;49;19M',
		'\u001b[<0;49;19m',
		'\u001b[<65;49;19M',
	];
	for (const reply of replies) emitData(reply);
	await send('first');
	recordClaudeInput(h.pty, '\r');
	for (const reply of replies) emitData(reply);
	await send('second');
	expect(h.writes).toEqual([
		'\u001b[200~first\u001b[201~',
		'\r',
		'\u001b[200~second\u001b[201~',
		'\r',
	]);
	recordClaudeInput(h.pty, 'unfinished human draft');
	for (const reply of replies) emitData(reply);
	expect(await rejection(send('third'))).toContain('human input draft');
	expect(h.writes).toHaveLength(4);
});

test('concurrent room and mail notices cannot interleave their paste and Enter', async () => {
	const h = fixture();
	let release = (): void => {};
	const firstWait = new Promise<void>((resolve) => {
		release = resolve;
	});
	let waits = 0;
	const send = claudeNoticeSender(
		h.pty,
		() => Promise.resolve(),
		() => {
			waits++;
			return waits === 1 ? firstWait : Promise.resolve();
		},
	);
	const room = send('room');
	const mail = send('mail');
	await Bun.sleep(0);
	expect(h.writes).toEqual(['\u001b[200~room\u001b[201~']);
	release();
	await Promise.all([room, mail]);
	expect(h.writes).toEqual([
		'\u001b[200~room\u001b[201~',
		'\r',
		'\u001b[200~mail\u001b[201~',
		'\r',
	]);
});

test('closing or communication halt during paste prevents the delayed Enter and queued notices', async () => {
	const h = fixture();
	let ready = true;
	const send = claudeNoticeSender(
		h.pty,
		() => {
			if (!ready) return Promise.reject(new Error('closed'));
			return Promise.resolve();
		},
		() => {
			ready = false;
			return Promise.resolve();
		},
	);
	const first = send('first');
	const queued = send('queued');
	expect(await rejection(first)).toContain('closed');
	expect(await rejection(queued)).toBe('closed');
	expect(h.writes).toEqual(['\u001b[200~first\u001b[201~']);
});

test('a post-paste abort retains one draft and refuses stacking until the human clears it', async () => {
	const h = fixture();
	let waits = 0;
	const send = claudeNoticeSender(
		h.pty,
		() => Promise.resolve(),
		() => {
			if (++waits === 1) return Promise.reject(new Error('halt arrived after paste'));
			return Promise.resolve();
		},
	);
	const failure: unknown = await send('one').catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(NotificationUnsubmittedError);
	const deferred: unknown = await send('two').catch((error: unknown) => error);
	expect(deferred).toBeInstanceOf(NotificationNotSentError);
	expect(h.writes).toEqual(['\u001b[200~one\u001b[201~']);
	recordClaudeInput(h.pty, '\u0015');
	await send('three');
	expect(h.writes).toEqual(['\u001b[200~one\u001b[201~', '\u001b[200~three\u001b[201~', '\r']);
});

test('human draft blocks automatic submission until the human submits or clears it', async () => {
	const h = fixture();
	const send = claudeNoticeSender(
		h.pty,
		() => Promise.resolve(),
		() => Promise.resolve(),
	);
	recordClaudeInput(h.pty, 'unfinished human text');
	expect(await rejection(send('notice'))).toContain('human input draft');
	expect(h.writes).toEqual([]);
	recordClaudeInput(h.pty, '\r');
	await send('notice');
	expect(h.writes.at(-1)).toBe('\r');
});

test('human edits between paste and Enter prevent submitting their text', async () => {
	const h = fixture();
	const send = claudeNoticeSender(
		h.pty,
		() => Promise.resolve(),
		() => {
			recordClaudeInput(h.pty, 'human edit');
			return Promise.resolve();
		},
	);
	expect(await rejection(send('notice'))).toContain('Human input changed');
	expect(h.writes).toEqual(['\u001b[200~notice\u001b[201~']);
});
