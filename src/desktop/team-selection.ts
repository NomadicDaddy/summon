import type { TeamEvent, TeamSnapshot } from './types.ts';

import { loadAgent, slugFor } from '../store.ts';

interface SelectionTeam {
	selected: string;
	sessions: ReadonlyMap<string, { agent: { status: string } }>;
	snapshot: () => Promise<TeamSnapshot>;
}

/** Lookup and snapshot completion must not undo a newer operator selection. */
export function teamSelection(
	team: SelectionTeam,
	emit: (event: TeamEvent) => void,
): (name: string) => Promise<void> {
	let latest = 0;
	return async (name) => {
		const slug = slugFor(name);
		const request = ++latest;
		const exists =
			team.sessions.get(slug)?.agent.status === 'running' || !!(await loadAgent(slug));
		if (request !== latest) return;
		if (!exists) throw new Error('Agent no longer exists.');
		team.selected = slug;
		const value = await team.snapshot();
		if (request === latest && value.selected === slug && team.selected === slug)
			emit({ type: 'snapshot', value });
	};
}
