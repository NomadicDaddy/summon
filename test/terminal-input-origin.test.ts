import { expect, test } from 'bun:test';

import { bindTerminalInput } from '../src/desktop/terminal-input-origin.ts';

function fixture() {
	let key: (event: { key: string }) => void = () => {};
	let data: (data: string) => void = () => {};
	const sent: { data: string; humanInput: boolean }[] = [];
	bindTerminalInput(
		{
			onKey: (listener) => {
				key = listener;
			},
			onData: (listener) => {
				data = listener;
			},
		},
		(data, humanInput) => {
			sent.push({ data, humanInput });
		},
	);
	return {
		key: (value: string) => key({ key: value }),
		data: (value: string) => data(value),
		sent,
	};
}

test('terminal replies pass through without being labeled human typing', () => {
	const h = fixture();
	for (const reply of [
		'\u001b[?1;2c',
		'\u001b[0n',
		'\u001b[1;1R',
		'\u001b[I',
		'\u001b]10;rgb:ffff/ffff/ffff\u0007',
	])
		h.data(reply);
	expect(h.sent.every((event) => !event.humanInput)).toBe(true);
	expect(h.sent).toHaveLength(5);
});

test('xterm mode-query replies cannot create a draft without keyboard input', () => {
	const h = fixture();
	for (const reply of ['\u001b[?2026;2$y', '\u001b[?2004;2$y', '\u001b[?25;1$y']) h.data(reply);
	expect(h.sent.map((event) => event.humanInput)).toEqual([false, false, false]);
	h.key('\u001b[?25;1$y');
	h.data('\u001b[?25;1$y');
	expect(h.sent.at(-1)?.humanInput).toBe(true);
	for (const value of ['\u001b[?25;9$y', '\u001b[?25;1$yhuman text', 'human text']) h.data(value);
	expect(h.sent.slice(-3).every((event) => event.humanInput)).toBe(true);
});

test('browser palette and status-string replies are protocol data with keyboard precedence', () => {
	const h = fixture();
	const replies = [
		'\u001b]4;0;rgb:2e2e/3434/3636\u001b\\',
		'\u001b]4;255;rgb:aaaa/bbbb/cccc\u0007',
		'\u001bP1$r0m\u001b\\',
		'\u001bP1$r2 q\u001b\\',
		'\u001bP1$r0"q\u001b\\',
		'\u001bP1$r61;1"p\u001b\\',
		'\u001bP1$r1;24r\u001b\\',
		'\u001bP0$r\u001b\\',
	];
	for (const reply of replies) h.data(reply);
	expect(h.sent.every((event) => !event.humanInput)).toBe(true);
	for (const reply of replies) {
		h.key(reply);
		h.data(reply);
	}
	expect(h.sent.slice(replies.length).every((event) => event.humanInput)).toBe(true);
	for (const value of [
		'\u001b]4;256;rgb:aaaa/bbbb/cccc\u001b\\',
		'\u001b]4;0;rgb:human text\u001b\\',
		'\u001bP1$rhuman text\u001b\\',
		'\u001bP1$r0m\u001b\\human text',
	])
		h.data(value);
	expect(h.sent.slice(-4).every((event) => event.humanInput)).toBe(true);
});

test('keyboard origin wins even when a function key resembles a terminal reply', () => {
	const h = fixture();
	const key = '\u001b[1;2R';
	h.key(key);
	h.data(key);
	h.data(key);
	expect(h.sent.map((event) => event.humanInput)).toEqual([true, false]);
});

test('mouse reports pass through without creating a draft, with keyboard precedence', () => {
	const h = fixture();
	const reports = [
		'\u001b[<35;49;19M',
		'\u001b[<0;49;19M',
		'\u001b[<0;49;19m',
		'\u001b[<65;49;19M',
		'\u001b[M QR',
		'\u001b[32;49;19M',
	];
	for (const report of reports) h.data(report);
	expect(h.sent.map((event) => event.humanInput)).toEqual(reports.map(() => false));
	expect(h.sent.map((event) => event.data)).toEqual(reports);
	for (const report of reports) {
		h.key(report);
		h.data(report);
	}
	expect(h.sent.slice(reports.length).every((event) => event.humanInput)).toBe(true);
	for (const value of [
		'\u001b[<35;0;19M',
		'\u001b[<35;49;19Mtext',
		'\u001b[M QRtext',
		'\u001b[M\rQR',
		'\u001b[32;49;0M',
		'\u001b[32;49;19Mtext',
	])
		h.data(value);
	expect(h.sent.slice(-6).every((event) => event.humanInput)).toBe(true);
});

test('typing, history navigation, Escape and multiline paste remain human input', () => {
	const h = fixture();
	for (const data of ['text', '\u001b[A', '\u001b', '\u001b[200~one\ntwo\u001b[201~'])
		h.data(data);
	expect(h.sent.every((event) => event.humanInput)).toBe(true);
});
