import type { PaneSwitchDiagnostic } from './mention-scan-metrics.ts';
import type { SelectTiming, TeamSnapshot } from './types.ts';

interface Switching {
	slug: string;
	clickedAt: number;
	started: number;
	paintMs: number | null;
}

export interface PaneSwitchDeps {
	render: (snapshot: TeamSnapshot) => void;
	select: (slug: string, clickedAt: number) => Promise<SelectTiming>;
	/** Runs the select, reporting its error as every Window action does; true on success. */
	action: (run: () => Promise<void>) => Promise<boolean>;
	report: (record: PaneSwitchDiagnostic) => void;
	now?: () => number;
	clock?: () => number;
	frame?: (callback: () => void) => void;
}

function outcomeOf(superseded: boolean, ok: boolean): PaneSwitchDiagnostic['outcome'] {
	if (superseded) return 'superseded';
	return ok ? 'complete' : 'failed';
}

export interface PaneSwitch {
	/** Paint the clicked teammate's pane at once, from the snapshot the renderer already has. */
	preview: (slug: string) => void;
	/** Send the select, record the switch, and restore the real selection if it failed. */
	select: (slug: string) => Promise<boolean>;
	/** Every incoming snapshot passes through here, so an older one can't undo the click. */
	snapshot: (value: TeamSnapshot) => TeamSnapshot;
}

/**
 * A teammate switch used to wait for main's full roster snapshot before anything changed on
 * screen, which took seconds behind a busy scan (#47527). The pane now switches on the click; the
 * full snapshot follows and corrects anything stale, and each switch is timed into its own ring.
 */
export function paneSwitch(deps: PaneSwitchDeps): PaneSwitch {
	const now = deps.now ?? (() => performance.now());
	const clock = deps.clock ?? (() => Date.now());
	const frame = deps.frame ?? ((callback: () => void) => requestAnimationFrame(callback));
	let current: TeamSnapshot | null = null;
	let pending: Switching | null = null;
	const begin = (slug: string): Switching => {
		pending = { slug, clickedAt: clock(), started: now(), paintMs: null };
		return pending;
	};
	return {
		preview: (slug) => {
			if (!current?.agents.some((member) => member.slug === slug)) return;
			const switching = begin(slug);
			deps.render({ ...current, selected: slug });
			// The second frame after the render is the first one the operator can see.
			frame(() =>
				frame(() => {
					switching.paintMs = Math.round(now() - switching.started);
				}),
			);
		},
		select: async (slug) => {
			const switching = pending?.slug === slug ? pending : begin(slug);
			const result: { timing: SelectTiming | null } = { timing: null };
			const ok = await deps.action(async () => {
				result.timing = await deps.select(slug, switching.clickedAt);
			});
			const superseded = pending !== switching;
			if (!superseded) pending = null;
			deps.report({
				kind: 'switch',
				at: new Date(switching.clickedAt).toISOString(),
				durationMs: Math.round(now() - switching.started),
				paintMs: switching.paintMs,
				ipcWaitMs: result.timing?.ipcWaitMs ?? null,
				selectMs: result.timing?.selectMs ?? null,
				outcome: outcomeOf(superseded, ok),
			});
			if (!ok && !superseded && current) deps.render(current);
			return ok;
		},
		snapshot: (value) => {
			current = value;
			if (!pending || value.selected === pending.slug) return value;
			return { ...value, selected: pending.slug };
		},
	};
}
