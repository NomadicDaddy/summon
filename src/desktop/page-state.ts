/**
 * The Team Window page's last-known layout, kept by the main process (C14, Roger on df84bdd).
 *
 * A hung renderer cannot be asked anything, so the page sends this whenever it changes and the main
 * process keeps the newest copy with its time. Every renderer-failure line in the fault journal then
 * says what the page looked like when it last could say, and how long ago that was.
 */
export interface PageState {
	scrollX: number;
	scrollY: number;
	bodyWidth: number;
	bodyHeight: number;
	viewWidth: number;
	viewHeight: number;
	focused: string;
}

const NUMBERS = [
	'scrollX',
	'scrollY',
	'bodyWidth',
	'bodyHeight',
	'viewWidth',
	'viewHeight',
] as const;

/** The value as a page state, or null when it is not one (it crosses the process boundary). */
export function pageStateFrom(value: unknown): PageState | null {
	if (typeof value !== 'object' || value === null) return null;
	const record = value as Record<string, unknown>;
	for (const key of NUMBERS) {
		const n = record[key];
		if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1e7) return null;
	}
	const focused = record['focused'];
	if (typeof focused !== 'string') return null;
	return {
		scrollX: record['scrollX'] as number,
		scrollY: record['scrollY'] as number,
		bodyWidth: record['bodyWidth'] as number,
		bodyHeight: record['bodyHeight'] as number,
		viewWidth: record['viewWidth'] as number,
		viewHeight: record['viewHeight'] as number,
		focused: focused.replace(/[^\w#.:-]/g, '').slice(0, 120),
	};
}

export const px = (n: number): string => String(Math.round(n));

/** The page state in words, as the fault journal shows it. */
export function pageStateText(state: PageState): string {
	return `page moved by ${px(state.scrollX)}, ${px(state.scrollY)} px; page ${px(state.bodyWidth)}x${px(state.bodyHeight)}, window ${px(state.viewWidth)}x${px(state.viewHeight)}; focus on ${state.focused || 'nothing'}`;
}

/**
 * The sentence a failure line ends with: the last page state and its age, or that none was
 * received. It says only what the main process saw: the page may never have sent one, or a report
 * may have been refused or lost on the way (Roger on 735655b), so it names no cause.
 */
export function lastPageText(last: { at: number; state: PageState } | null, now: number): string {
	if (!last) return 'Last page state: unavailable, none was received from the page.';
	const age = Math.max(0, Math.round((now - last.at) / 1000));
	return `Last page state, ${String(age)} s old: ${pageStateText(last.state)}.`;
}
