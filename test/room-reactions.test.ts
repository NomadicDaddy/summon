import { describe, expect, test } from 'bun:test';

import type { LocalEvent } from '../src/local-room.ts';

import { isHumanReaction } from '../src/desktop/room-reactions.ts';

/*
 * The predicate decides what stops being a post, so every way of getting it WRONG costs something
 * real: too broad and an ordinary message disappears from the transcript, too narrow and the column
 * of bare thumbs-up this change exists to remove stays.
 *
 * attachReaction is not covered here - it is DOM work, and summon has no DOM in bun:test. It is
 * verified in the built window instead, against a fixture carrying each of these cases.
 */
const event = (partial: Partial<LocalEvent>): LocalEvent => ({
	at: '2026-10-01T18:00:00.000Z',
	id: 2,
	replyTo: 1,
	sender: { id: 'operator', kind: 'user' },
	source: 'local',
	text: '👍',
	...partial,
});

describe('isHumanReaction', () => {
	test('a human thumbs-up replying to a message is a reaction', () => {
		expect(isHumanReaction(event({}))).toBe(true);
	});

	test('surrounding whitespace does not stop it being one', () => {
		expect(isHumanReaction(event({ text: '  👍\n' }))).toBe(true);
	});

	test('a thumbs-up carrying any other words stays a post', () => {
		// The words are the message. Hiding them would delete what the operator actually said.
		expect(isHumanReaction(event({ text: '👍 and also nice work' }))).toBe(false);
	});

	test('an unrelated emoji stays a post', () => {
		expect(isHumanReaction(event({ text: '🎉' }))).toBe(false);
	});

	test('an agent thumbs-up stays a post', () => {
		// Only the human's approval carries authority, and only it is noise as its own row.
		expect(isHumanReaction(event({ sender: { id: 'bruno', kind: 'agent' } }))).toBe(false);
	});

	test('a thumbs-up replying to nothing stays a post', () => {
		// With no target there is nothing to draw it on, and it is a remark rather than an approval.
		expect(isHumanReaction(event({ replyTo: null }))).toBe(false);
	});

	test('an empty message is not a reaction', () => {
		expect(isHumanReaction(event({ text: '' }))).toBe(false);
	});
});
