import type { TeamSnapshot } from './types.ts';

export interface SelectionTarget {
	selected: string;
	running: boolean;
	terminal: { focus: () => void } | undefined;
}

export interface SelectionFocus {
	/** Focus only after a successful selection and only for the latest operator request. */
	select: (
		slug: string,
		run: () => Promise<boolean>,
		current: () => SelectionTarget,
	) => Promise<boolean>;
}

export function selectionTarget(
	snapshot: TeamSnapshot,
	terminal: SelectionTarget['terminal'],
): SelectionTarget {
	return {
		selected: snapshot.selected,
		running: snapshot.agents.some(
			(member) => member.slug === snapshot.selected && member.status === 'running',
		),
		terminal,
	};
}

export function selectionFocus(): SelectionFocus {
	let latest = 0;
	return {
		select: async (slug, run, current) => {
			const request = ++latest;
			// Team.select publishes before resolving. Routine renders cannot consume this request.
			const done = await run();
			if (!done || request !== latest) return done;
			const target = current();
			if (target.selected === slug && target.running) target.terminal?.focus();
			return done;
		},
	};
}

/**
 * All explicit member-selection controls share one request generation. `preview` paints the
 * chosen pane at once, before the select's round trip to main.
 */
export function memberSelection(
	run: (slug: string) => Promise<boolean>,
	current: () => SelectionTarget,
	preview?: (slug: string) => void,
): (slug: string) => Promise<boolean> {
	const focus = selectionFocus();
	return (slug) => {
		preview?.(slug);
		return focus.select(slug, () => run(slug), current);
	};
}
