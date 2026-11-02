import { expect, test } from 'bun:test';

import type { TeamAgent } from '../src/desktop/types.ts';
import type { Presence } from '../src/session-presence.ts';

import {
	EXTERNAL_PRESENCE_REFRESH_MS,
	externalPresence,
	heldStatus,
} from '../src/desktop/external-presence.ts';
import { offlineTitle } from '../src/desktop/hibernation-controls.ts';
import { headerState, memberStateLabel, stateTone } from '../src/desktop/member-identity.ts';

/*
 * verified-member-presence clause 4: a session held outside this window reads online only when its
 * process identity is verified. A lock that cannot be verified is its own state, never green.
 */
const seen = (state: Presence['state'], reason = 'checked'): Presence => ({
	observedAt: '2026-10-23T20:30:00.000Z',
	reason,
	state,
});
const agent = (over: Partial<TeamAgent> = {}): TeamAgent => ({
	activity: 'idle',
	cwd: 'D:/work',
	name: 'Probe',
	provider: 'claude',
	slug: 'probe',
	status: 'unknown',
	...over,
});

test('only a verified online session reads In another window', () => {
	expect(heldStatus(seen('online'))).toBe('elsewhere');
	expect(heldStatus(seen('unknown'))).toBe('unknown');
	// The guard says held but presence says gone: still not verified, so not offline either.
	expect(heldStatus(seen('offline'))).toBe('unknown');
	expect(heldStatus(undefined)).toBe('unknown');
});

test('one snapshot serves the same held set until it is stale, and a changed set reads at once', async () => {
	const calls: string[][] = [];
	const resolve = (members: { slug: string; provider: string }[]) => {
		calls.push(members.map((member) => member.slug));
		return Promise.resolve(new Map(members.map((member) => [member.slug, seen('online')])));
	};
	const pair = [
		{ provider: 'claude', slug: 'a' },
		{ provider: 'kilo', slug: 'b' },
	];
	await externalPresence(pair, resolve, 1_000);
	await externalPresence([...pair].reverse(), resolve, 2_000);
	expect(calls).toHaveLength(1);
	await externalPresence(pair.slice(0, 1), resolve, 3_000);
	expect(calls).toHaveLength(2);
	await externalPresence(pair.slice(0, 1), resolve, 3_000 + EXTERNAL_PRESENCE_REFRESH_MS);
	expect(calls).toHaveLength(3);
	// Nothing held: no snapshot at all, and the next held set is read fresh.
	expect((await externalPresence([], resolve, 4_000)).size).toBe(0);
	await externalPresence(pair.slice(0, 1), resolve, 4_001);
	expect(calls).toHaveLength(4);
});

test('an unverified lock says so, with its reason and time, and is never Ready, Busy or green', () => {
	const unknown = agent({
		activity: 'busy',
		presence: seen('unknown', 'process details could not be read'),
	});
	expect(memberStateLabel(unknown)).toBe('Lock held, not verified');
	expect(stateTone(memberStateLabel(unknown))).toBeUndefined();
	const header = headerState(unknown, undefined);
	expect(header.className).toBe('unknown');
	expect(header.title).toStartWith(
		'Lock held, not verified: process details could not be read. Checked ',
	);
	expect(offlineTitle(agent())).toBe('Lock held, not verified');
	// The control: a verified session held elsewhere is online and reports its activity.
	expect(memberStateLabel(agent({ activity: 'busy', status: 'elsewhere' }))).toBe('Busy');
});
