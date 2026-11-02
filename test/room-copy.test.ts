import { describe, expect, test } from 'bun:test';

import type { LocalEvent } from '../src/local-room.ts';

import { memberDetail } from '../src/desktop/member-detail.ts';
import { messageOnly, messageWithDetails } from '../src/desktop/room-copy.ts';

/*
 * The text that lands on the clipboard is the whole feature, so each line of the detailed form is
 * pinned here. copyButton is DOM work and is verified in the built window instead (summon has no
 * DOM in bun:test), with the acceptance record under scratch/shared/jimmy/room-copy.
 */
const event = (partial: Partial<LocalEvent>): LocalEvent => ({
	at: '2026-10-08T19:51:25.755Z',
	id: 7351,
	replyTo: null,
	sender: { id: 'jimmy', kind: 'agent' },
	source: 'local',
	text: 'show me the summon bell\nwith the colors inverted',
	...partial,
});
const stamp = (instant: Date): string => `STAMP(${instant.toISOString()})`;
const claude = { cwd: 'D:/work', provider: 'claude' as const };
const withModel = {
	...claude,
	modelInfo: {
		model: 'claude-fable-5-1',
		observedAt: '2026-10-08T19:00:00.000Z',
		provider: 'claude' as const,
		reasoning: 'high',
		sessionId: 's1',
	},
};

describe('messageOnly', () => {
	test('is the text exactly as posted, newlines and all', () => {
		expect(messageOnly(event({}))).toBe('show me the summon bell\nwith the colors inverted');
	});
});

describe('messageWithDetails', () => {
	test('leads with number, sender and stamp, then the model, a blank line and the text', () => {
		expect(messageWithDetails(event({}), withModel, stamp)).toBe(
			[
				'#7351 · jimmy · STAMP(2026-10-08T19:51:25.755Z)',
				'claude · claude-fable-5-1 · high · capacity not recorded · D:/work',
				'',
				'show me the summon bell\nwith the colors inverted',
			].join('\n'),
		);
	});

	test('names the human as you and carries no model line', () => {
		const text = messageWithDetails(
			event({ sender: { id: 'operator', kind: 'user' } }),
			undefined,
			stamp,
		);
		expect(text.split('\n')[0]).toBe(
			'#7351 · operator (you) · STAMP(2026-10-08T19:51:25.755Z)',
		);
		expect(text).not.toContain('Model');
	});

	test('says the model is not recorded yet rather than omitting the line', () => {
		expect(messageWithDetails(event({}), claude, stamp).split('\n')[1]).toBe(
			'claude · model not recorded · reasoning not recorded · capacity not recorded · D:/work',
		);
	});

	test('says reasoning is not exposed when the provider saved none', () => {
		const { model, observedAt, provider, sessionId } = withModel.modelInfo;
		const author = { ...withModel, modelInfo: { model, observedAt, provider, sessionId } };
		expect(messageWithDetails(event({}), author, stamp).split('\n')[1]).toBe(
			'claude · claude-fable-5-1 · reasoning not exposed by provider · capacity not recorded · D:/work',
		);
	});

	test('is the session header line, account included (Phillip #7999)', () => {
		const author = {
			...withModel,
			claudeConfigDir: 'D:/accounts/claude-work',
			name: 'Jimmy',
			slug: 'jimmy',
			status: 'running' as const,
		};
		expect(messageWithDetails(event({}), author, stamp).split('\n')[1]).toBe(
			memberDetail(author).text,
		);
		expect(memberDetail(author).text).toBe(
			'claude · claude-fable-5-1 · high · capacity not recorded · Account: claude-work · D:/work',
		);
	});

	test('a sender no longer on the roster is said to be, not guessed', () => {
		expect(messageWithDetails(event({}), undefined, stamp).split('\n')[1]).toBe(
			'Not on the roster',
		);
	});

	test('keeps the reply target and a non-local source', () => {
		const text = messageWithDetails(
			event({ replyTo: 7349, source: 'telegram' }),
			withModel,
			stamp,
		);
		expect(text.split('\n').slice(0, 3)).toEqual([
			'#7351 · jimmy · STAMP(2026-10-08T19:51:25.755Z) · telegram',
			'claude · claude-fable-5-1 · high · capacity not recorded · D:/work',
			'Reply to #7349',
		]);
	});

	test('the default stamp is local time with its zone named', () => {
		const line = messageWithDetails(event({}), withModel).split('\n')[0] ?? '';
		expect(line).toMatch(/^#7351 · jimmy · .*2026.*\d{2}:\d{2}:\d{2}.*[A-Z]{2,5}|GMT[+-]\d/);
	});
});
