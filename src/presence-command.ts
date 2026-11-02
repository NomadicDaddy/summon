import { resolvePresence } from './session-presence.ts';
import { listAgentSlugs, loadAgent } from './store.ts';

/** One member's presence row for `summon --presence` and summon-who; the Team Window reads the same resolver. */
export interface PresenceRow {
	name: string;
	slug: string;
	provider: string;
	state: 'online' | 'offline' | 'unknown' | 'unreadable';
	reason: string;
	observedAt: string;
	hibernated: boolean;
}

/** Read-only: no launch, bind, lock removal, mail or transcript read. One process snapshot per report. */
export async function presenceRows(): Promise<PresenceRow[]> {
	const rows: PresenceRow[] = [];
	const members: { slug: string; provider: string; name: string; hibernated: boolean }[] = [];
	for (const slug of await listAgentSlugs()) {
		try {
			const record = await loadAgent(slug);
			if (record)
				members.push({
					slug,
					provider: record.provider,
					name: record.name,
					hibernated: record.hibernation?.active === true,
				});
		} catch (error: unknown) {
			rows.push({
				name: slug,
				slug,
				provider: '',
				state: 'unreadable',
				reason: error instanceof Error ? error.message : String(error),
				observedAt: new Date().toISOString(),
				hibernated: false,
			});
		}
	}
	const presence = await resolvePresence(members);
	for (const member of members) {
		const found = presence.get(member.slug);
		if (found) rows.push({ ...member, ...found });
	}
	return rows;
}

export async function presenceCommand(args: string[]): Promise<void> {
	if (args.length) throw new Error('Usage: summon --presence');
	console.log(JSON.stringify(await presenceRows()));
}
