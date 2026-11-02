import { expect, test } from 'bun:test';

import { pinManagers } from '../src/desktop/roster-order.ts';

const member = (slug: string, memberType: 'pm' | 'teammate' = 'teammate') => ({ slug, memberType });
const order = (agents: ReturnType<typeof member>[]): string[] =>
	pinManagers(agents).map((agent) => agent.slug);

test('a PM is first whatever its name, and nobody else moves', () => {
	expect(
		order([member('alice'), member('carl'), member('steward', 'pm'), member('vera')]),
	).toEqual(['steward', 'alice', 'carl', 'vera']);
});

test('several PMs take the first rows in the order they already had', () => {
	expect(
		order([member('alice'), member('pat', 'pm'), member('carl'), member('morgan', 'pm')]),
	).toEqual(['pat', 'morgan', 'alice', 'carl']);
});

test('a roster with no PM, or only PMs, or nobody, is returned in its own order', () => {
	expect(order([member('b'), member('a')])).toEqual(['b', 'a']);
	expect(order([member('b', 'pm'), member('a', 'pm')])).toEqual(['b', 'a']);
	expect(order([])).toEqual([]);
});

test('the list passed in is not reordered in place', () => {
	const agents = [member('alice'), member('steward', 'pm')];
	pinManagers(agents);
	expect(agents.map((agent) => agent.slug)).toEqual(['alice', 'steward']);
});
