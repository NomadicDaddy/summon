import { expect, test } from 'bun:test';

import { roomNameMatcher } from '../src/desktop/room-names.ts';
import { DEFAULT_OPERATOR_IDENTITY } from '../src/operator-identity-model.ts';

/*
 * Which names the Team Room marks, and which it leaves alone.
 *
 * The Electron probe proves what a marked name LOOKS like - the green pill for the human, the
 * per-agent colour, the grey pill for @all. It is a poor place to prove WHICH text earns one,
 * because every case needs a rendered room and a read back out of the DOM. These are the decisions
 * themselves, and the negative ones matter as much as the positive: a mention mark that fires on
 * ordinary prose is worth less than no mark at all, because the reader stops trusting it.
 *
 * #4975: "if using @operator to address me, it needs to be handled like phillip - this message was
 * not highlighted like it was addressed to me."
 */
const match = roomNameMatcher(
	[
		{ name: 'Morgan', slug: 'morgan' },
		{ name: 'Jimmy', slug: 'jimmy' },
	],
	{ display: 'Phillip', aliases: [], mentionOnly: ['operator'], recipientAliases: ['op', 'me'] },
);

const kinds = (line: string): string[] => match(line).map((one) => `${one.label}:${one.kind}`);

test('@operator marks the human, exactly as @phillip does', () => {
	expect(kinds('@operator ack this')).toEqual(['@operator:human']);
	expect(kinds('@phillip ack this')).toEqual(['@phillip:human']);
});

test('both of the human names resolve to the same id, so they colour alike', () => {
	const [viaId] = match('@operator');
	const [viaName] = match('@phillip');
	expect(viaId?.id).toBe('operator');
	expect(viaName?.id).toBe('operator');
});

test('the human name is case-insensitive', () => {
	expect(kinds('@Operator and @PHILLIP')).toEqual(['@Operator:human', '@PHILLIP:human']);
});

test('operator without the @ is left alone, because it is an ordinary word', () => {
	expect(match('the operator retirement in #2565')).toEqual([]);
	expect(match('a board operator moving blocked to ready')).toEqual([]);
});

test('phillip without the @ still marks, because the word only ever means him', () => {
	expect(kinds('ask phillip first')).toEqual(['phillip:human']);
});

test('a longer word that merely starts with operator does not mark', () => {
	expect(match('@operators are plural')).toEqual([]);
	expect(match('@operator-led change')).toEqual([]);
});

test('an address is not a mention', () => {
	expect(match('write to operator@example.com')).toEqual([]);
	expect(match('ping me@operator now')).toEqual([]);
});

test('agents and the broadcast name are unaffected by the alias', () => {
	expect(kinds('@morgan and @jimmy, @all')).toEqual([
		'@morgan:agent',
		'@jimmy:agent',
		'@all:all',
	]);
});

test('offsets point at the label, so the caller can split the line around it', () => {
	const line = 'please @operator look';
	const [one] = match(line);
	expect(one?.at).toBe(line.indexOf('@operator'));
	expect(line.slice(one?.at ?? 0, (one?.at ?? 0) + (one?.label.length ?? 0))).toBe('@operator');
});

test('new teams and an unrelated configured operator do not inherit another human name', () => {
	const line = 'Phillip @phillip operator @operator';
	expect(roomNameMatcher([], DEFAULT_OPERATOR_IDENTITY)(line)).toEqual([
		{ at: line.indexOf('@operator'), id: 'operator', kind: 'human', label: '@operator' },
	]);
	const other = roomNameMatcher([], {
		display: 'Rae',
		aliases: ['Rachel'],
		mentionOnly: ['operator'],
		recipientAliases: ['op', 'me'],
	});
	expect(other('Rae Rachel @operator op me Phillip').map((item) => item.label)).toEqual([
		'Rae',
		'Rachel',
		'@operator',
	]);
});

test('a member collision stays an agent in the renderer and empty prose alternatives do not match @', () => {
	const identity = {
		display: 'Operator',
		aliases: [],
		mentionOnly: ['operator'],
		recipientAliases: [],
	};
	expect(
		roomNameMatcher([{ slug: 'operator', name: 'Operator' }], identity)('@operator')[0]?.kind,
	).toBe('agent');
	expect(roomNameMatcher([], identity)('@ @operators operator')).toEqual([]);
});

test('a refused identity has no human names while agent and broadcast marks remain usable', () => {
	const refused = roomNameMatcher([{ slug: 'rae', name: 'Rae' }]);
	expect(
		refused('@operator Phillip @rae @all').map((item) => `${item.label}:${item.kind}`),
	).toEqual(['@rae:agent', '@all:all']);
});
