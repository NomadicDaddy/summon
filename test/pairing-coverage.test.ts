import { expect, test } from 'bun:test';

import { pairingCoverage, providerExposure } from '../src/pairing-coverage.ts';

test('cover is derived across the whole roster, because no single record carries the shape', () => {
	// A chain: its last link is uncovered, and nothing in Alice's own record could say so.
	const chain = pairingCoverage([
		{ name: 'Carl', coveredBy: 'Morgan' },
		{ name: 'Morgan' },
		{ name: 'Alice', coveredBy: 'Carl' },
	]);
	expect(chain.uncovered).toEqual(['Morgan']);
	expect(chain.entries.find((entry) => entry.name === 'Carl')?.covers).toEqual(['Alice']);
	expect(chain.overSubscribed).toEqual([]);
	// A ring covers everyone with one assignment each and leaves nobody over.
	const ring = pairingCoverage([
		{ name: 'Carl', coveredBy: 'Dave' },
		{ name: 'Dave', coveredBy: 'Jack' },
		{ name: 'Jack', coveredBy: 'Carl' },
	]);
	expect(ring.uncovered).toEqual([]);
	// Two names may point at one, which is legal and is exactly what nobody would notice.
	const shared = pairingCoverage([
		{ name: 'Alice', coveredBy: 'Carl' },
		{ name: 'Dave', coveredBy: 'Carl' },
		{ name: 'Carl' },
	]);
	expect(shared.overSubscribed).toEqual(['Carl']);
	expect(shared.entries.find((entry) => entry.name === 'Carl')?.covers).toEqual([
		'Alice',
		'Dave',
	]);
	expect(shared.uncovered).toEqual(['Carl']);
	// A coverer outside the roster still counts as cover; it is simply credited to nobody present.
	const outside = pairingCoverage([{ name: 'Carl', coveredBy: 'Nobody' }]);
	expect(outside.uncovered).toEqual([]);
	expect(outside.entries[0]?.covers).toEqual([]);
});

test('a provider outage is measured by who is left unattended, not by which edges it touches', () => {
	// The live roster's shape on 2026-09-26. The shipped line counted edges whose COVERER ran the
	// failed provider and so named Jack and Morgan for a claude outage - both of whom are working -
	// while Alice, Carl and Jimmy would have nobody. Corrected in #1507; this is the regression.
	const roster = [
		{ name: 'Alice', provider: 'claude' },
		{ name: 'Carl', provider: 'claude' },
		{ name: 'Jimmy', provider: 'claude' },
		{ name: 'Dave', provider: 'claude', coveredBy: 'Jack' },
		{ name: 'Jack', provider: 'grok', coveredBy: 'Dave' },
		{ name: 'Morgan', provider: 'codex', coveredBy: 'Carl' },
	];
	const [worst] = providerExposure(roster);
	expect(worst?.provider).toBe('claude');
	expect(worst?.unattended).toEqual(['Alice', 'Carl', 'Jimmy']);
	// The two the old line named are absent, because a claude outage does not stop either of them.
	expect(worst?.unattended).not.toContain('Jack');
	expect(worst?.unattended).not.toContain('Morgan');
	// And Dave is held: he is down, but his coverer runs grok and is still there. That is the whole
	// point of a cross-provider pair, and the previous measure could not express it.
	expect(worst?.unattended).not.toContain('Dave');
	// claude is the ONLY entry, which is the corrected measure's sharpest consequence: a grok outage
	// stops Jack and a codex outage stops Morgan, and each has a coverer who is still running, so
	// neither outage leaves a domain unheld. A provider that costs nothing is absent rather than
	// listed with an empty list, so the rows that exist are all rows worth reading.
	expect(providerExposure(roster).map((entry) => entry.provider)).toEqual(['claude']);
});

test('cover that shares the failed provider is reported separately, because it should be impossible', () => {
	// saveProfile refuses a same-provider coverer, so this shape can only reach the graph from a
	// record written around the rule. It is the one exposure fact that is not the uncovered set
	// regrouped, which is why it is reported rather than folded into the count.
	const [worst] = providerExposure([
		{ name: 'Carl', provider: 'claude', coveredBy: 'Dave' },
		{ name: 'Dave', provider: 'claude', coveredBy: 'Carl' },
	]);
	expect(worst?.unattended).toEqual(['Carl', 'Dave']);
	expect(worst?.despiteCover).toEqual(['Carl', 'Dave']);
	// A sound pair reports nothing here, and nothing at all: nobody is left unattended.
	expect(
		providerExposure([
			{ name: 'Carl', provider: 'claude', coveredBy: 'Jack' },
			{ name: 'Jack', provider: 'grok', coveredBy: 'Carl' },
		]),
	).toEqual([]);
});

test('a coverer whose provider cannot be established is not credited with surviving', () => {
	// The name is outside the roster, so nothing here shows it survives the outage. Claiming cover
	// we cannot establish is the failure this module exists to avoid, so it is not claimed.
	const [worst] = providerExposure([{ name: 'Carl', provider: 'claude', coveredBy: 'Nobody' }]);
	expect(worst?.unattended).toEqual(['Carl']);
	expect(worst?.despiteCover).toEqual(['Carl']);
});
