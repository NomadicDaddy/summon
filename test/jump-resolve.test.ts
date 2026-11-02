import { describe, expect, test } from 'bun:test';

import type { JumpCard, JumpPerson, JumpTarget } from '../src/desktop/jump-resolve.ts';

import { selectBoardCards } from '../src/desktop/board-search-view.ts';
import {
	HELD_ENTER,
	heldChoice,
	JUMP_LIMIT,
	jumpKey,
	jumpLabel,
	resolveJump,
} from '../src/desktop/jump-resolve.ts';

/*
 * What a Jump entry resolves to (card e6619a2e). The box, its keys and the going are DOM work and
 * are verified in the built window (summon has no DOM in bun:test); held here is the rule that
 * decides what was meant, and the Board rule that lets a jumped-to card be shown.
 */
const people: JumpPerson[] = [
	{ name: 'Ada', slug: 'ada' },
	{ name: 'Dave', slug: 'dave' },
	{ name: 'Morgan', slug: 'morgan' },
	{ name: 'Morticia', slug: 'morticia' },
];
const card = (id: string, patch: Partial<JumpCard> = {}): JumpCard => ({
	archived: false,
	id,
	owner: 'morgan',
	state: 'doing',
	title: `Card ${id.slice(0, 4)}`,
	...patch,
});
const cards = [
	card('150ea87c-bfbf-45a6-bdd2-827ab67a4b06'),
	card('8355aa10-0000-4000-8000-000000000001', { archived: true, owner: 'dave' }),
	card('adaf0000-0000-4000-8000-000000000002', { owner: '' }),
];
const kinds = (targets: JumpTarget[]): string[] =>
	targets.map((target) =>
		target.kind === 'room'
			? `room:${String(target.id)}`
			: target.kind === 'card'
				? `card:${target.card.id.slice(0, 4)}`
				: `person:${target.person.slug}`,
	);

describe('resolveJump', () => {
	test('nothing typed is nothing, with no complaint', () => {
		expect(resolveJump('  ', people, cards)).toEqual({
			more: 0,
			note: '',
			nothing: '',
			pending: false,
			targets: [],
		});
	});

	test('the start of a name comes before a card id that starts the same way', () => {
		// On the real Board "da" and "ed" each start a card id (Morticia #8601). Enter takes the
		// first match, so two letters of Dave must land on Dave.
		const real = [...cards, card('da3868af-0000-4000-8000-000000000003')];
		// Ada only contains "da", so she comes after the card.
		expect(kinds(resolveJump('da', people, real).targets)).toEqual([
			'person:dave',
			'card:da38',
			'person:ada',
		]);
		// A name that only contains the entry comes after the card; one that starts with it, before.
		expect(
			kinds(
				resolveJump('ad', people, [card('ad26d219-0000-4000-8000-000000000004')]).targets,
			),
		).toEqual(['person:ada', 'card:ad26']);
		expect(
			kinds(
				resolveJump('a8', [{ name: 'Sa8ra', slug: 'sa8ra' }], [card('a8000000-0')]).targets,
			),
		).toEqual(['card:a800', 'person:sa8ra']);
	});

	test('while the Board is being read, a possible card id is not called a miss', () => {
		const loading = resolveJump('9f3', people, [], 'loading');
		expect(loading).toEqual({
			more: 0,
			note: 'Reading the Board for card ids…',
			nothing: '',
			pending: true,
			targets: [],
		});
		// Other readings are listed meanwhile, but it is too early to go: the card may be meant.
		const number = resolveJump('15', people, [], 'loading');
		expect(kinds(number.targets)).toEqual(['room:15']);
		expect(number.pending).toBe(true);
		// An entry that cannot be a card id does not wait for the Board.
		expect(resolveJump('mor', people, [], 'loading').pending).toBe(false);
		expect(resolveJump('mor', people, [], 'loading').note).toBe('');
	});

	test('a Board that could not be read is said, and is not a miss either', () => {
		const failed = resolveJump('150e', people, cards, 'failed');
		expect(failed.targets).toEqual([]);
		expect(failed.nothing).toBe('');
		expect(failed.note).toBe('The Board could not be read, so card ids cannot be looked up.');
		expect(failed.pending).toBe(false);
		// The other kinds still work.
		expect(kinds(resolveJump('15', people, cards, 'failed').targets)).toEqual(['room:15']);
		expect(kinds(resolveJump('dave', people, cards, 'failed').targets)).toEqual([
			'person:dave',
		]);
	});

	test('a leading # always means a Room message', () => {
		expect(kinds(resolveJump('#8355', people, cards).targets)).toEqual(['room:8355']);
		const bad = resolveJump('#ada', people, cards);
		expect(bad.targets).toEqual([]);
		expect(bad.nothing).toBe('After # comes a Room message number.');
	});

	test('a bare number lists the message and any card id it starts, never one alone', () => {
		expect(kinds(resolveJump('8355', people, cards).targets)).toEqual([
			'room:8355',
			'card:8355',
		]);
		expect(kinds(resolveJump('42', people, cards).targets)).toEqual(['room:42']);
	});

	test('the start of a card id finds the card, another owner or archived included', () => {
		expect(kinds(resolveJump('150E', people, cards).targets)).toEqual(['card:150e']);
		expect(kinds(resolveJump('150ea87c-bfbf', people, cards).targets)).toEqual(['card:150e']);
		const archived = resolveJump('8355aa', people, cards).targets[0];
		expect(archived && jumpLabel(archived)).toEqual({
			detail: '8355aa10 · dave · archived',
			kind: 'Card',
			title: 'Card 8355',
		});
	});

	test('a name that is also hexadecimal lists the teammate first, then the card', () => {
		expect(kinds(resolveJump('ada', people, cards).targets)).toEqual([
			'person:ada',
			'card:adaf',
		]);
	});

	test('a teammate is found by the start of the name before a match inside it', () => {
		expect(kinds(resolveJump('mor', people, cards).targets)).toEqual([
			'person:morgan',
			'person:morticia',
		]);
		expect(kinds(resolveJump('av', people, cards).targets)).toEqual(['person:dave']);
		expect(kinds(resolveJump('  MORGAN ', people, cards).targets)).toEqual(['person:morgan']);
	});

	test('a miss says what was tried', () => {
		expect(resolveJump('9f3', people, cards).nothing).toBe(
			'No teammate is named 9f3 and no card id starts with it.',
		);
		expect(resolveJump('zed', people, cards).nothing).toContain('No teammate is named zed.');
	});

	test('a long list is cut, and says how many more there are', () => {
		const many = Array.from({ length: JUMP_LIMIT + 5 }, (_, index) =>
			card(`ab${index.toString(16).padStart(2, '0')}0000-0000-4000-8000-000000000000`),
		);
		const answer = resolveJump('ab', people, many);
		expect(answer.targets).toHaveLength(JUMP_LIMIT);
		expect(answer.more).toBe(5);
	});

	test('never reads a title, an owner or a state', () => {
		for (const query of ['card', 'doing', 'archived'])
			expect(resolveJump(query, [], cards).targets).toEqual([]);
	});
});

describe('a choice made while the Board was still being read', () => {
	const keysFor = (query: string, boardCards: JumpCard[]): string[] =>
		resolveJump(query, people, boardCards).targets.map(jumpKey);
	const twoCards = [
		card('ab110000-0000-4000-8000-000000000001'),
		card('ab220000-0000-4000-8000-000000000002'),
	];

	test('Enter goes when exactly one thing matched', () => {
		expect(heldChoice(HELD_ENTER, keysFor('150e', cards), 'ready')).toBe(0);
		expect(heldChoice(HELD_ENTER, keysFor('dave', cards), 'ready')).toBe(0);
	});

	test('Enter does not pick between two cards under one prefix', () => {
		const keys = keysFor('ab', twoCards);
		expect(keys).toHaveLength(2);
		expect(heldChoice(HELD_ENTER, keys, 'ready')).toBe(-1);
	});

	test('Enter does not take the message when the number also starts a card id', () => {
		const keys = keysFor('8355', cards);
		expect(keys).toEqual(['room:8355', 'card:8355aa10-0000-4000-8000-000000000001']);
		expect(heldChoice(HELD_ENTER, keys, 'ready')).toBe(-1);
	});

	test('nothing goes by itself after a failed read, so the failure is seen', () => {
		const keys = resolveJump('15', people, [], 'failed').targets.map(jumpKey);
		expect(keys).toEqual(['room:15']);
		expect(heldChoice(HELD_ENTER, keys, 'failed')).toBe(-1);
		expect(heldChoice('room:15', keys, 'failed')).toBe(-1);
	});

	test('a clicked match is that match, wherever it now sits, or nothing if it has gone', () => {
		const keys = keysFor('8355', cards);
		expect(heldChoice('room:8355', keys, 'ready')).toBe(0);
		expect(heldChoice(keys[1] ?? '', keys, 'ready')).toBe(1);
		expect(heldChoice('room:9', keys, 'ready')).toBe(-1);
	});

	test('no choice is no jump', () => {
		expect(heldChoice(null, keysFor('150e', cards), 'ready')).toBe(-1);
	});
});

describe('a jumped-to card on the Board', () => {
	const item = (id: string, patch: Record<string, unknown> = {}) => ({
		archived: false,
		blockedOn: null,
		comments: [],
		createdAt: '2026-10-10T17:00:00.000Z',
		description: '',
		evidence: [],
		id,
		owner: 'morgan',
		partner: '',
		project: 'summon',
		revision: 1,
		state: 'ready' as const,
		title: `Card ${id}`,
		updatedAt: '2026-10-10T17:00:00.000Z',
		...patch,
	});
	const items = [
		item('mine'),
		item('theirs', { owner: 'dave' }),
		item('old', { archived: true }),
	];
	const none = { matchesOnly: true, query: '', withArchived: true };
	const ids = (selection: { visible: { id: string }[] }): string[] =>
		selection.visible.map((entry) => entry.id);

	test('is shown past the owner filter, archived or not, and only that card', () => {
		expect(ids(selectBoardCards(items, 'morgan', none))).toEqual(['mine']);
		expect(ids(selectBoardCards(items, 'morgan', none, 'theirs'))).toEqual(['mine', 'theirs']);
		expect(ids(selectBoardCards(items, 'morgan', none, 'old'))).toEqual(['mine', 'old']);
		expect(ids(selectBoardCards(items, 'morgan', none, 'mine'))).toEqual(['mine']);
		expect(ids(selectBoardCards(items, 'morgan', none, 'gone'))).toEqual(['mine']);
	});

	test('is shown through a search that would have left it out', () => {
		const search = { matchesOnly: true, query: 'zzzz', withArchived: false };
		expect(ids(selectBoardCards(items, null, search, 'old'))).toEqual(['old']);
	});
});
