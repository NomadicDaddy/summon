import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { checkpointText } from '../src/checkpoint-text.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

test('readable checkpoint includes all fields, bodies, fragments and recovery warnings', () => {
	const value = {
		receipt: 'exact receipt',
		changed: false,
		more: true,
		package: { phase: 'final', page: 3, pages: 3 },
		mail: {
			messages: [{ text: 'first\nsecond \\n 😀', header: { from: 'beta', kind: 'request' } }],
			errors: [{ error: 'unread failure' }],
		},
		fragments: [
			{ text: '{"text":"fragment\\n"}', offset: 12, end: 40, size: 99, source: 'hold' },
		],
		warning: 'replay warning',
		nextReadError: 'transport failed',
		acknowledgedReceipt: 'prior receipt',
		futureField: { value: 'must remain visible' },
	};
	const rendered = checkpointText(value);
	for (const text of [
		'CHECKPOINT FINAL RECEIPT',
		'exact receipt',
		'first\nsecond \\n 😀',
		'{"text":"fragment\\n"}',
		'unread failure',
		'replay warning',
		'transport failed',
		'prior receipt',
		'must remain visible',
		'more: true',
		'fragments[0].offset: 12',
	])
		expect(rendered).toContain(text);
	expect(value.mail.messages[0]?.text).toBe('first\nsecond \\n 😀');
	expect(checkpointText({ text: '\u001b[2J\rhidden\u0085' })).toContain(
		'\\u001b[2J\\u000dhidden\\u0085',
	);
	expect(
		checkpointText({
			hibernated: true,
			changed: false,
			more: false,
			instruction: 'Remain dormant',
		}),
	).toStartWith('CHECKPOINT HIBERNATED');
});

test('text view replays the same page and requires its separate final receipt', async () => {
	const fixture = await mailHarness();
	try {
		expect((await fixture.run(['--room', 'send', 'full body\nsecond line'], 'beta')).code).toBe(
			0,
		);
		const page = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as {
			receipt: string;
		};
		const before = await fixture.read('runtime/alpha/checkpoint.json');
		const replay = await fixture.run(['--checkpoint', '--format', 'text'], 'alpha');
		expect(replay.code).toBe(0);
		expect(replay.out).toContain('CHECKPOINT PAGE');
		expect(replay.out).toContain(page.receipt);
		expect(replay.out).toContain('full body\nsecond line');
		expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(before);
		expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(
			false,
		);
		const final = await fixture.run(
			['--checkpoint', page.receipt, '--format', 'text'],
			'alpha',
		);
		expect(final.out).toContain('CHECKPOINT FINAL RECEIPT');
		expect(final.out).toContain('more: true');
		expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(
			false,
		);
		const state = JSON.parse(await fixture.read('runtime/alpha/checkpoint-package.json')) as {
			finalReceipt: string;
		};
		const quiet = await fixture.run(
			['--checkpoint', state.finalReceipt, '--format', 'text'],
			'alpha',
		);
		expect(quiet.out).toContain('CHECKPOINT QUIET');
		expect(await fixture.read('runtime/alpha/room.cursor')).toBe('1');
		for (const args of [
			['--format', 'json'],
			['--format'],
			['bad', '--format', 'text', 'extra'],
		])
			expect((await fixture.run(['--checkpoint', ...args], 'alpha')).code).toBe(1);
	} finally {
		await fixture.dispose();
	}
});
