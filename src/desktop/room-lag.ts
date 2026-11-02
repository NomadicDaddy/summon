import type { TeamAgent } from './types.ts';

/**
 * Which teammate has acknowledged the least of the room, and how to say so without overclaiming.
 *
 * A session hundreds of events behind the room reads exactly like one at the head: Morgan sat at
 * cursor 1107 for twenty hours while the head passed 1600, and nothing on screen said so. The
 * runtime now carries `roomProgress` per teammate, so the fact exists; this decides what is worth
 * showing and in what words.
 *
 * ONLY THE FURTHEST BEHIND, not a badge on every row. That is the decision roster-coverage.ts
 * already made for provider exposure - only the worst outage, because while the rule holds every
 * other row is the same set regrouped - and the same holds here: in a quiet hour everyone is a few
 * events back, and marking all of them spends the reader's attention on the normal case. One line
 * answers the question that is actually being asked, which is whether anyone has fallen out of
 * step.
 *
 * NO THRESHOLD. Any cut-off between "a few behind" and "too far behind" would be invented here and
 * then read as meaningful. The count is shown instead, because the operator can judge a number
 * against what they know about the hour and this module cannot.
 */
export interface RoomLag {
	/** The last event id this teammate has receipted. */
	cursor: number;
	/** The newest event id in the room. */
	head: number;
	name: string;
	/** Events after the cursor. Not a count of anything anyone failed to understand. */
	pending: number;
	slug: string;
}

/**
 * The teammate with the most unacknowledged events, or undefined when nobody is behind.
 *
 * A teammate whose `roomProgress` is absent is skipped rather than treated as zero: absent means
 * the room metadata could not be read, and a teammate nobody can measure is not a teammate at the
 * head. Ties break on name so the line does not flicker between two equal teammates on each redraw.
 */
/**
 * How many teammates carry no room progress at all.
 *
 * The line above names the furthest behind OF THOSE REPORTING, which is a smaller claim than it
 * reads as. If two teammates have no progress metadata, either could be further behind than the one
 * named and nothing here would know. That is the same overclaim "Cover: 6 of 7" made before it
 * became "Cover recorded", and it has to be said on screen rather than only in a comment.
 */
export function notReporting(agents: readonly Measured[]): number {
	return agents.filter(counted).filter((agent) => agent.roomProgress === undefined).length;
}

type Measured = Pick<TeamAgent, 'roomProgress'> & Partial<Pick<TeamAgent, 'status'>>;

/**
 * HIBERNATED RECORDS ARE NOT COUNTED (#6022). A hibernated member is paused by the operator and is
 * not expected to read the room, so its cursor stops while the head moves on. Counting it named
 * "Roger, 6021 events unacknowledged" from a hibernated duplicate record whose cursor had never
 * moved, while the active Roger session was 18 behind - the line read as a fact about the session
 * doing the work. Leaving hibernated records out is not an overclaim: the line answers whether a
 * teammate meant to be keeping up has fallen out of step, and a hibernated one is not meant to.
 */
function counted(agent: Measured): boolean {
	return agent.status !== 'hibernated';
}

export function furthestBehind(
	agents: readonly (Pick<TeamAgent, 'name' | 'slug'> & Measured)[],
): RoomLag | undefined {
	const behind = agents
		.filter(counted)
		.flatMap<RoomLag>((agent) =>
			agent.roomProgress === undefined || agent.roomProgress.pending <= 0
				? []
				: [{ name: agent.name, slug: agent.slug, ...agent.roomProgress }],
		);
	const lag = behind
		.sort((left, right) => right.pending - left.pending || left.name.localeCompare(right.name))
		.at(0);
	if (lag === undefined) return undefined;
	/*
	 * Two records can share a display name - Roger has an active Codex record and a hibernated Kilo
	 * one. A name another record also answers to does not say which of them is behind, so the slug
	 * goes with it. Checked against every record, hibernated ones included, because the reader knows
	 * both exist even though only one is counted.
	 */
	const shared = agents.some((agent) => agent.slug !== lag.slug && agent.name === lag.name);
	return shared ? { ...lag, name: `${lag.name} (${lag.slug})` } : lag;
}

/**
 * How the fact is worded, kept beside the selection so a second display cannot word it differently.
 *
 * "Unacknowledged" and "through", never "read" or "behind by". A cursor records what was receipted;
 * it is not evidence that anyone took it in, and a roster that implies otherwise repeats the
 * mistake "Cover: 6 of 7" made before it became "Cover recorded". The numbers carry the distance,
 * the verb carries only what the data can support.
 *
 * THE COUNT ONLY, not the cursor range, and that was decided at the rendered window rather than
 * here. The sidebar is about thirty characters wide at this size, so every draft carrying both
 * numbers took three lines and left a fragment alone on the last one - first "since", then
 * "#1600". The count is the fact the roster exists to surface; which event id a teammate sits on is
 * forensic detail that belongs where somebody acts on it, not in a block you scan. Two lines.
 *
 * `cursor` and `head` stay on RoomLag because they come from the runtime contract and a detail view
 * would want them. `pending` is reported rather than derived from head minus cursor: event ids need
 * not be contiguous, so the subtraction would usually agree and quietly not always.
 */
export function roomLagText(lag: RoomLag): string {
	const events = lag.pending === 1 ? '1 event' : `${String(lag.pending)} events`;
	return `${events} unacknowledged`;
}
