/**
 * Draggable, remembered dividers between the window's regions, per Phillip's #1367 and #1430.
 *
 * The sidebar, room, board and operator drawer each have a boundary handle. Each writes a CSS
 * custom property that its layout reads, so the grid and the flex column stay declarative and this
 * module only ever moves a number.
 *
 * Kept off the card level deliberately - #1430 said the lines on the whole UI, not the kanban cards,
 * and dragging a card between lanes is a different feature with a different persistence story.
 */
interface Splitter {
	/** The handle's element id. */
	id: string;
	/** `x` moves a vertical divider left and right; `y` moves a horizontal one up and down. */
	axis: 'x' | 'y';
	/** The custom property the layout reads. */
	property: string;
	/** Smallest the region may become, in pixels. */
	min: number;
	/** Largest it may become. A function because it depends on the window, which resizes. */
	max: () => number;
	/** The region's size right now, measured rather than remembered. */
	measure: () => number;
	/** Which way the drag runs: the sidebar grows rightwards, the room grows leftwards. */
	invert?: boolean;
	readonly label: string;
}

const KEY = 'summon:layout';
const STEP = 16;

function region(id: string): HTMLElement | null {
	return document.getElementById(id);
}

function size(id: string, axis: 'x' | 'y'): number {
	const node = region(id);
	if (node === null) return 0;
	const box = node.getBoundingClientRect();
	return axis === 'x' ? box.width : box.height;
}

const SPLITTERS: Splitter[] = [
	{
		axis: 'x',
		id: 'split-aside',
		label: 'Resize the teammate list',
		max: () => Math.min(520, window.innerWidth * 0.4),
		measure: () => size('sidebar', 'x'),
		min: 180,
		property: '--aside-width',
	},
	{
		axis: 'x',
		id: 'split-room',
		invert: true,
		label: 'Resize the team room',
		max: () => Math.min(1100, window.innerWidth * 0.6),
		measure: () => size('room', 'x'),
		min: 320,
		property: '--room-width',
	},
	{
		axis: 'y',
		id: 'split-work',
		label: 'Resize the work panel and session',
		max: () => Math.max(200, window.innerHeight - 240),
		measure: () =>
			Math.max(...['board', 'diary', 'repos', 'schedules'].map((id) => size(id, 'y'))),
		min: 120,
		property: '--board-height',
	},
	{
		axis: 'y',
		id: 'split-operator',
		invert: true,
		label: 'Resize the operator terminal',
		max: () => Math.max(170, window.innerHeight - 200),
		measure: () => size('operator', 'y'),
		min: 170,
		property: '--operator-height',
	},
];

/**
 * Reads the remembered sizes. Wrapped because storage throws in a private window and comes back
 * empty after cleared site data, and a layout that refuses to render without it would be worse than
 * one that falls back to the defaults in the stylesheet.
 */
function load(): Record<string, number> {
	try {
		const raw = window.localStorage.getItem(KEY);
		if (raw === null) return {};
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === 'object' && parsed !== null
			? (parsed as Record<string, number>)
			: {};
	} catch {
		return {};
	}
}

function save(sizes: Record<string, number>): void {
	try {
		window.localStorage.setItem(KEY, JSON.stringify(sizes));
	} catch {
		// A size that cannot be remembered is still a size that works for this session.
	}
}

const sizes = load();

function apply(spec: Splitter, next: number): void {
	const clamped = Math.round(Math.min(Math.max(next, spec.min), spec.max()));
	document.documentElement.style.setProperty(spec.property, `${String(clamped)}px`);
	sizes[spec.property] = clamped;
	const handle = region(spec.id);
	handle?.setAttribute('aria-valuenow', String(clamped));
	handle?.setAttribute('aria-valuemax', String(spec.max()));
}

function wire(spec: Splitter): void {
	const handle = region(spec.id);
	if (handle === null) return;
	handle.setAttribute('role', 'separator');
	handle.setAttribute('aria-orientation', spec.axis === 'x' ? 'vertical' : 'horizontal');
	handle.setAttribute('aria-label', spec.label);
	handle.setAttribute('aria-valuemin', String(spec.min));
	handle.setAttribute('aria-valuemax', String(spec.max()));
	handle.tabIndex = 0;

	let start = 0;
	let from = 0;
	handle.addEventListener('pointerdown', (event: PointerEvent) => {
		start = spec.axis === 'x' ? event.clientX : event.clientY;
		// Measured at grab rather than read from the remembered value, because the region may be
		// sized by the stylesheet's default and never have been dragged.
		from = spec.measure();
		handle.setPointerCapture(event.pointerId);
		document.body.classList.add('is-splitting');
		event.preventDefault();
	});
	handle.addEventListener('pointermove', (event: PointerEvent) => {
		if (!handle.hasPointerCapture(event.pointerId)) return;
		const now = spec.axis === 'x' ? event.clientX : event.clientY;
		const delta = now - start;
		apply(spec, from + (spec.invert === true ? -delta : delta));
	});
	const release = (event: PointerEvent): void => {
		if (!handle.hasPointerCapture(event.pointerId)) return;
		handle.releasePointerCapture(event.pointerId);
		document.body.classList.remove('is-splitting');
		save(sizes);
	};
	handle.addEventListener('pointerup', release);
	handle.addEventListener('pointercancel', release);

	// A divider only a mouse can move is a divider half the people here cannot use.
	handle.addEventListener('keydown', (event: KeyboardEvent) => {
		const back = spec.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
		const forward = spec.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
		const current = spec.measure();
		let next: number | null = null;
		if (event.key === back) next = current + (spec.invert === true ? STEP : -STEP);
		else if (event.key === forward) next = current + (spec.invert === true ? -STEP : STEP);
		else if (event.key === 'Home') next = spec.min;
		else if (event.key === 'End') next = spec.max();
		if (next === null) return;
		event.preventDefault();
		apply(spec, next);
		save(sizes);
	});
}

/** Wires every divider present in the document and restores the sizes from the last session. */
export function setupSplitters(): void {
	for (const spec of SPLITTERS) {
		const remembered = sizes[spec.property];
		if (typeof remembered === 'number') apply(spec, remembered);
		wire(spec);
	}
}
