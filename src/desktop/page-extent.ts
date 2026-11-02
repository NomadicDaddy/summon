import { px } from './page-state.ts';

/**
 * What made the window's page taller or wider than the window, measured when the page moves
 * (remediation-20261016-room-message-focus-page-shift).
 *
 * Phillip's window journalled the page moving 275 px while its body was exactly the window's size
 * (#13294), so the extra height came from something outside body's clip. The record names the
 * root's scroll size and the element reaching furthest past the window that no clipping ancestor
 * holds in, so the next occurrence says what to fix.
 */
export interface PageExtent {
	pageWidth: number;
	pageHeight: number;
	/** The outermost element reaching furthest past the window, or '' when none does. */
	outermost: string;
	/** The innermost element inside it at the same reach; the same element when nothing is. */
	innermost: string;
	right: number;
	bottom: number;
}

/** An element as the journal names it: tag, id and first class. */
export const describe = (element: Element | null): string => {
	if (!element) return 'nothing';
	const id = element.id ? `#${element.id}` : '';
	const kind =
		typeof element.className === 'string' && element.className
			? `.${element.className.split(/\s+/)[0] ?? ''}`
			: '';
	return `${element.tagName.toLowerCase()}${id}${kind}`;
};

/**
 * Whether the element's box can extend the page: no ancestor that holds it clips it. An absolutely
 * placed element is held only by its positioned ancestors, so it escapes a clipping body whose
 * ancestors are static; a fixed one is held by the window and never extends the page.
 */
function reachesPage(element: Element): boolean {
	let position = getComputedStyle(element).position;
	for (
		let up = element.parentElement;
		up && up !== document.documentElement;
		up = up.parentElement
	) {
		const style = getComputedStyle(up);
		const holds = position === 'absolute' ? style.position !== 'static' : position !== 'fixed';
		if (!holds) continue;
		if (style.overflowX !== 'visible' || style.overflowY !== 'visible') return false;
		position = style.position;
	}
	return position !== 'fixed';
}

/**
 * Measures the page's scroll size and the elements reaching furthest past the window: the
 * outermost, and the innermost inside it at the same reach, since either can be the cause
 * (Morticia on b79050a). Called only when the page has moved: it reads every element's box.
 */
export function measureExtent(): PageExtent {
	const page = document.scrollingElement ?? document.documentElement;
	// Boxes are placed on the page by the root's offset only: body scrolling moves what is inside
	// body, never body's own box.
	const scrollX = page.scrollLeft;
	const scrollY = page.scrollTop;
	const extent: PageExtent = {
		pageWidth: page.scrollWidth,
		pageHeight: page.scrollHeight,
		outermost: '',
		innermost: '',
		right: 0,
		bottom: 0,
	};
	let past = 0;
	let outer: Element | null = null;
	let inner: Element | null = null;
	// Body comes first and its descendants in document order, so an ancestor is always met before
	// the elements inside it.
	for (const element of [document.body, ...document.body.querySelectorAll('*')]) {
		const box = element.getBoundingClientRect();
		const right = box.right + scrollX;
		const bottom = box.bottom + scrollY;
		const beyond = Math.max(right - window.innerWidth, bottom - window.innerHeight);
		if (beyond <= 0 || beyond < past || !reachesPage(element)) continue;
		if (beyond === past) {
			if (outer?.contains(element)) inner = element;
			continue;
		}
		past = beyond;
		outer = element;
		inner = element;
		extent.right = right;
		extent.bottom = bottom;
	}
	if (outer && inner) {
		extent.outermost = describe(outer);
		extent.innermost = describe(inner);
	}
	return extent;
}

/** The extent in words, as the fault journal shows it. */
export function extentText(extent: PageExtent): string {
	const size = `the page could scroll to ${px(extent.pageWidth)}x${px(extent.pageHeight)}`;
	if (!extent.outermost) return `${size}, with nothing in it reaching past the window`;
	const named =
		extent.innermost === extent.outermost
			? extent.outermost
			: `${extent.outermost}, innermost ${extent.innermost}`;
	return `${size}; furthest past the window: ${named}, reaching ${px(extent.right)} px across and ${px(extent.bottom)} px down`;
}
