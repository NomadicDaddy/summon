import { type Presence, resolvePresence } from '../session-presence.ts';

/** How long one verdict for the same set of held sessions is reused before it is read again. */
export const EXTERNAL_PRESENCE_REFRESH_MS = 15_000;

let cached: { key: string; at: number; presence: Map<string, Presence> } | undefined;

/**
 * Presence for the members whose session lock is held outside this window, from one process
 * snapshot for all of them. The snapshot starts pwsh, so the verdict is reused while the same set
 * stays held, for up to EXTERNAL_PRESENCE_REFRESH_MS. A change in the set reads again at once. The
 * launch guard is still checked on every poll, so a lock that is released stops counting at once.
 */
export async function externalPresence(
	members: { slug: string; provider: string }[],
	resolve: typeof resolvePresence = resolvePresence,
	now = Date.now(),
): Promise<Map<string, Presence>> {
	if (!members.length) {
		cached = undefined;
		return new Map();
	}
	const key = members
		.map((member) => `${member.slug}:${member.provider}`)
		.sort()
		.join(',');
	if (cached?.key === key && now - cached.at < EXTERNAL_PRESENCE_REFRESH_MS)
		return cached.presence;
	const presence = await resolve(members);
	cached = { at: now, key, presence };
	return presence;
}

/** The roster status for a session this window does not own, from the guard and its presence. */
export function heldStatus(presence: Presence | undefined): 'elsewhere' | 'unknown' {
	return presence?.state === 'online' ? 'elsewhere' : 'unknown';
}
