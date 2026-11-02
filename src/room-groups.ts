import { addressableText } from './room-address.ts';
import { type Presence, resolvePresence } from './session-presence.ts';
import { listAgentSlugs, loadAgent } from './store.ts';

/** Group mentions resolved once, when the message is sent; replay and delayed delivery reuse them. */
export interface RoomGroups {
	online?: string[];
	offline?: string[];
}

type GroupName = keyof RoomGroups;
const GROUPS: readonly GroupName[] = ['online', 'offline'];

export type PresenceResolver = (
	members: { slug: string; provider: string }[],
) => Promise<Map<string, Presence>>;

/** Whole @online and @offline tokens outside fenced code, quotes and inline code. */
export function mentionedGroups(text: string): GroupName[] {
	const addressable = addressableText(text);
	return GROUPS.filter((group) =>
		new RegExp(`(?<![\\p{L}\\p{N}_@])@${group}(?![\\p{L}\\p{N}_-])`, 'iu').test(addressable),
	);
}

/**
 * The members each mentioned group selects at send time, from verified presence only: online
 * takes verified online members, offline takes definitely offline ones, and unknown takes neither.
 * The sending agent is never its own recipient. Undefined when the text mentions no group.
 */
export async function resolveRoomGroups(
	text: string,
	sender: { kind: string; id: string },
	resolve: PresenceResolver = resolvePresence,
): Promise<RoomGroups | undefined> {
	const groups = mentionedGroups(text);
	if (!groups.length) return;
	const members: { slug: string; provider: string }[] = [];
	for (const slug of await listAgentSlugs()) {
		if (sender.kind === 'agent' && slug === sender.id) continue;
		// An unreadable registration has no verifiable presence, so no group selects it.
		const record = await loadAgent(slug).catch(() => undefined);
		if (record) members.push({ slug, provider: record.provider });
	}
	const presence = members.length ? await resolve(members) : new Map<string, Presence>();
	const resolved: RoomGroups = {};
	for (const group of groups)
		resolved[group] = members
			.filter((member) => presence.get(member.slug)?.state === group)
			.map((member) => member.slug);
	return resolved;
}

/** More recipients than any team holds means the stored list is not one this code wrote. */
export const MAX_GROUP_MEMBERS = 512;

/**
 * The stored shape, checked on every read: only the two named groups, each a bounded list of
 * distinct canonical member slugs. Which groups a message may carry is checked once, when it is
 * written (assertGroupsMatchText), not on every read: a later change to the token rules must
 * never turn existing room history invalid.
 */
export function validRoomGroups(value: unknown): value is RoomGroups | undefined {
	if (value === undefined) return true;
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	return Object.entries(value).every(
		([group, slugs]) =>
			(GROUPS as readonly string[]).includes(group) &&
			Array.isArray(slugs) &&
			slugs.length <= MAX_GROUP_MEMBERS &&
			new Set(slugs).size === slugs.length &&
			slugs.every(
				(slug) => typeof slug === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug),
			),
	);
}

/** Groups handed to a writer must be exactly the groups the text mentions, no more and no fewer. */
export function assertGroupsMatchText(groups: RoomGroups, text: string): void {
	const stored = Object.keys(groups).sort();
	const mentioned = [...mentionedGroups(text)].sort();
	if (stored.join(',') !== mentioned.join(','))
		throw new Error('Room groups do not match the group mentions in the message.');
}

/** The members a message's resolved groups address. */
export function groupRecipients(groups: RoomGroups | undefined): string[] {
	return [...new Set([...(groups?.online ?? []), ...(groups?.offline ?? [])])];
}

/**
 * Which resolved group members a mention wake may act on at delivery time. Offline members go
 * through the ordinary mention start, with its hibernation and rest checks. An online member is
 * kept only while it is still running, so an @online announcement never starts a member that
 * went offline after the message was sent. Members no longer registered are dropped.
 *
 * Only a human or CLI post acts on a group. An agent writing about @offline in prose would
 * otherwise start every stopped seat; its post still addresses the group in wake notices.
 */
export function groupWakeTargets(
	event: { sender: { kind: string }; groups?: RoomGroups },
	registered: readonly string[],
	isRunning: (slug: string) => boolean,
): string[] {
	if (event.sender.kind === 'agent') return [];
	const groups = event.groups;
	const online = (groups?.online ?? []).filter(isRunning);
	return [...new Set([...online, ...(groups?.offline ?? [])])].filter((slug) =>
		registered.includes(slug),
	);
}
