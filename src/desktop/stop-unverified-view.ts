import type { StopResult, TeamAgent } from './types.ts';

/**
 * The Window's side of an unverified Stop (Phillip #25640 on #25639). Summon attempted termination
 * once and has not seen the session's terminal exit, so this is neither a stop nor an error. Every
 * state surface reads the same label, the explanation names no process count (none is known), and
 * the Stop button stays disabled instead of inviting a second termination the main process would
 * refuse anyway (owned-session-stop.ts).
 */
export const STOP_UNVERIFIED = 'Stop unverified';

export const STOP_UNVERIFIED_TITLE =
	"Stop sent. Summon hasn't seen this session exit yet and will mark it stopped when it does.";

const ROOT_UNCHECKED = " Its main process couldn't be checked.";

/** The explanation, adding that the root could not be read when the stop's answer said so. */
export function stopUnverifiedTitle(rootUnchecked: boolean): string {
	return rootUnchecked ? `${STOP_UNVERIFIED_TITLE}${ROOT_UNCHECKED}` : STOP_UNVERIFIED_TITLE;
}

/**
 * Per-launch state for unverified stops. Only team:stop's answer knows whether the root could be
 * read (the snapshot carries just the flag), and only a launch's first unverified answer is a
 * termination attempt: a later Stop while unverified terminates nothing and answers unverified
 * again (owned-session-stop.ts).
 *
 * Each member's launch generation advances on the Window's `reset` event, which Team.start emits
 * before every new launch, so a replacement session never inherits the old one's note even when no
 * stopped snapshot came between them (Morgan 7307db24). The renderer reads the generation when
 * Stop is clicked and records the answer against it. `record` returns true once per generation, so
 * each attempt's diagnostic is journalled once. A late answer from an earlier launch is journalled
 * but never sets the current launch's note. The answer and the snapshot may arrive in either order.
 */
export function stopUnverifiedNotes(): {
	generation: (slug: string) => number;
	launch: (slug: string) => void;
	record: (slug: string, generation: number, result: StopResult | undefined) => boolean;
	title: (agent: TeamAgent | undefined) => string | undefined;
} {
	const generations = new Map<string, number>();
	const rootUnchecked = new Map<string, boolean>();
	const journalled = new Set<string>();
	const current = (slug: string): number => generations.get(slug) ?? 0;
	return {
		generation: current,
		launch: (slug) => {
			generations.set(slug, current(slug) + 1);
			rootUnchecked.delete(slug);
		},
		record: (slug, generation, result) => {
			if (!result || !('unverified' in result)) return false;
			const attempt = `${slug}\n${String(generation)}`;
			if (journalled.has(attempt)) return false;
			journalled.add(attempt);
			if (generation === current(slug)) rootUnchecked.set(slug, !result.rootChecked);
			return true;
		},
		title: (agent) =>
			agent?.stopUnverified
				? stopUnverifiedTitle(rootUnchecked.get(agent.slug) === true)
				: undefined,
	};
}

/** The selected member's Stop button: disabled and relabelled while its stop is unverified. */
export function renderStopButton(button: HTMLElement, agent: TeamAgent | undefined): void {
	const unverified = agent?.stopUnverified === true;
	// The attribute, so it holds for whatever element('stop') resolves to (an HTMLElement).
	button.toggleAttribute('disabled', unverified);
	button.textContent = unverified ? STOP_UNVERIFIED : 'Stop Session';
	button.title = unverified ? STOP_UNVERIFIED_TITLE : '';
}
