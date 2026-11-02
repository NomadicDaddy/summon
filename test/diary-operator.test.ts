import { describe, expect, test } from 'bun:test';

import { forOperator } from '../src/diary-operator.ts';
import { DEFAULT_OPERATOR_IDENTITY } from '../src/operator-identity-model.ts';

const identity = {
	display: 'Phillip',
	aliases: [],
	mentionOnly: ['operator'],
	recipientAliases: ['op', 'me'],
};
const DIARY_OPERATOR = identity.display;

describe('diary operator recipient (#6376, #6383)', () => {
	test('recognises the operator by name or alias, trimmed and in any case', () => {
		for (const name of [
			DIARY_OPERATOR,
			DIARY_OPERATOR.toUpperCase(),
			` ${DIARY_OPERATOR} `,
			'operator',
			'Operator',
			'op',
			'OP',
			'me',
			' Me ',
		])
			expect(forOperator(name, identity)).toBe(true);
	});

	test('keeps every other recipient, including near misses', () => {
		for (const name of ['Lead', 'Morgan', 'Dave', 'summon', 'mel', 'ops', `${DIARY_OPERATOR}s`])
			expect(forOperator(name, identity)).toBe(false);
	});

	test('recognition is team-specific without rewriting literal historical recipients', () => {
		const entry = { for: 'Phillip', task: 'Historical outcome' };
		const original = JSON.stringify(entry);
		const other = { ...DEFAULT_OPERATOR_IDENTITY, display: 'Rae', aliases: ['Rachel'] };
		expect(forOperator(entry.for, identity)).toBe(true);
		expect(forOperator(entry.for, other)).toBe(false);
		expect(forOperator(entry.for, DEFAULT_OPERATOR_IDENTITY)).toBe(false);
		expect(forOperator('Rachel', other)).toBe(true);
		expect(forOperator('operator', undefined)).toBe(false);
		expect(forOperator('Phillip', undefined)).toBe(false);
		expect(JSON.stringify(entry)).toBe(original);
	});
});
