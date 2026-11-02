import { expect, test } from 'bun:test';

import type { TeamAgent } from '../src/desktop/types.ts';

import { furthestBehind, notReporting, roomLagText } from '../src/desktop/room-lag.ts';

/*
 * Which teammate the roster names as furthest behind, and in what words.
 *
 * The Electron probe proves what the line LOOKS like. These are the decisions: who gets named, who
 * is skipped, and the wording - which is the part with a wrong answer that would look right. A
 * roster saying "read through" or "behind by" would be making a claim about attention that a
 * cursor cannot support, and nothing on screen would reveal the difference.
 */
type Agent = Pick<TeamAgent, 'name' | 'roomProgress' | 'slug'>;

const agent = (
	name: string,
	progress?: { cursor: number; head: number; pending: number },
): Agent =>
	progress === undefined
		? { name, slug: name.toLowerCase() }
		: { name, roomProgress: progress, slug: name.toLowerCase() };

test('names the teammate with the most unacknowledged events', () => {
	const lag = furthestBehind([
		agent('Alice', { cursor: 990, head: 1000, pending: 10 }),
		agent('Dave', { cursor: 500, head: 1000, pending: 500 }),
		agent('Carl', { cursor: 999, head: 1000, pending: 1 }),
	]);
	expect(lag?.name).toBe('Dave');
	expect(lag?.pending).toBe(500);
	expect(lag?.cursor).toBe(500);
});

test('nobody behind means no line at all, not a zero', () => {
	expect(
		furthestBehind([
			agent('Alice', { cursor: 1000, head: 1000, pending: 0 }),
			agent('Dave', { cursor: 1000, head: 1000, pending: 0 }),
		]),
	).toBeUndefined();
});

test('a teammate with no roomProgress is skipped, not counted as caught up', () => {
	const lag = furthestBehind([
		agent('Alice'),
		agent('Dave', { cursor: 900, head: 1000, pending: 100 }),
	]);
	expect(lag?.name).toBe('Dave');
	// The absent one must not be able to win by being treated as zero, nor to suppress the real one.
	expect(furthestBehind([agent('Alice')])).toBeUndefined();
});

test('an empty roster produces nothing', () => {
	expect(furthestBehind([])).toBeUndefined();
});

test('ties break on name so the line does not flicker between redraws', () => {
	const roster = [
		agent('Dave', { cursor: 900, head: 1000, pending: 100 }),
		agent('Alice', { cursor: 900, head: 1000, pending: 100 }),
	];
	expect(furthestBehind(roster)?.name).toBe('Alice');
	expect(furthestBehind([...roster].reverse())?.name).toBe('Alice');
});

test('the wording claims acknowledgement, never reading or understanding', () => {
	const text = roomLagText({
		cursor: 1107,
		head: 1600,
		name: 'Morgan',
		pending: 493,
		slug: 'morgan',
	});
	expect(text).toBe('493 events unacknowledged');
	expect(text).not.toContain('read');
	expect(text).not.toContain('behind by');
	expect(text).not.toContain('unread');
});

test('one event is singular', () => {
	const text = roomLagText({ cursor: 999, head: 1000, name: 'Carl', pending: 1, slug: 'carl' });
	expect(text).toContain('1 event unacknowledged');
	expect(text).not.toContain('1 events');
});

/*
 * The bound on the claim, which Morgan caught and I had not: "Furthest behind: Morgan" reads as a
 * fact about the roster, and it is a fact about the teammates whose progress could be read. One
 * unreporting teammate is enough to make the unqualified wording an overclaim.
 */
test('counts the teammates whose progress could not be read', () => {
	expect(
		notReporting([
			agent('Alice', { cursor: 1, head: 2, pending: 1 }),
			agent('Dave'),
			agent('Carl'),
		]),
	).toBe(2);
});

test('nobody unreporting means no caveat to draw', () => {
	expect(notReporting([agent('Alice', { cursor: 1, head: 2, pending: 1 })])).toBe(0);
	expect(notReporting([])).toBe(0);
});

test('a roster where NOBODY reports still counts them, so the caveat can be shown', () => {
	// furthestBehind returns undefined here, so the block draws nothing at all - but the count must
	// not quietly be zero, or a future caller would conclude the roster was fully measured.
	expect(notReporting([agent('Alice'), agent('Dave')])).toBe(2);
	expect(furthestBehind([agent('Alice'), agent('Dave')])).toBeUndefined();
});

/*
 * #6022, the shape that produced it: Roger has an active Codex record and a hibernated Kilo record
 * under the same display name. The hibernated one had never moved its cursor, so it "won" with the
 * whole room and the line read as a fact about the session actually doing the work.
 */
const roger = { cursor: 6020, head: 6038, pending: 18 };
const rogerKilo = { cursor: 0, head: 6038, pending: 6038 };
const hibernatedRoster = [
	{ name: 'Roger', roomProgress: roger, slug: 'roger', status: 'running' as const },
	{ name: 'Roger', roomProgress: rogerKilo, slug: 'roger.kilo', status: 'hibernated' as const },
	{
		name: 'Alice',
		roomProgress: { cursor: 6030, head: 6038, pending: 8 },
		slug: 'alice',
		status: 'running' as const,
	},
];

test('a hibernated record is not counted, however far behind its cursor sits', () => {
	const lag = furthestBehind(hibernatedRoster);
	expect(lag?.slug).toBe('roger');
	expect(lag?.pending).toBe(18);
	// Without the active Roger, the hibernated one still may not win: Alice is the furthest behind.
	expect(furthestBehind(hibernatedRoster.filter((a) => a.slug !== 'roger'))?.slug).toBe('alice');
	// A roster of only hibernated records names nobody.
	expect(
		furthestBehind(hibernatedRoster.filter((a) => a.status === 'hibernated')),
	).toBeUndefined();
});

test('a name another record shares carries its slug, so the line says which one', () => {
	expect(furthestBehind(hibernatedRoster)?.name).toBe('Roger (roger)');
	// A unique name stays bare.
	expect(furthestBehind(hibernatedRoster.filter((a) => a.slug !== 'roger'))?.name).toBe('Alice');
});

test('a hibernated record without progress is not reported as missing either', () => {
	const silentHibernated = [
		{ name: 'Roger', slug: 'roger.kilo', status: 'hibernated' as const },
		{ name: 'Alice', slug: 'alice', status: 'running' as const },
	];
	// Only Alice is expected to report, and she is the one missing.
	expect(notReporting(silentHibernated)).toBe(1);
	expect(notReporting(silentHibernated.filter((a) => a.status === 'hibernated'))).toBe(0);
});
