import type { BoardItem } from '../board-model.ts';

export interface BoardMatch {
	title: boolean;
	owner: boolean;
	text: Array<'description' | 'blocker' | 'evidence' | 'comments'>;
}

/** Normalize the literal query in the same way as Diary search. */
export function boardQuery(raw: string): string {
	return raw.trim().toLowerCase();
}

/**
 * Who or what a blocker names on the card: the target as written, or for a task blocker the title
 * of the blocking card. A task target is a card id, which the Board never shows, so search reads
 * the title the card displays instead (Morticia #8412). Empty when that card no longer exists.
 */
export function blockerName(item: BoardItem, items: readonly BoardItem[]): string {
	const blocker = item.blockedOn;
	if (!blocker) return '';
	if (blocker.kind !== 'task') return blocker.target;
	return items.find((candidate) => candidate.id === blocker.target)?.title ?? '';
}

/**
 * Report where a card matches; visibility and archived-card policy belong to the view. `items` is
 * the Board the card sits on, used only to resolve a task blocker to the title it displays.
 */
export function matchBoardItem(
	item: BoardItem,
	query: string,
	items: readonly BoardItem[] = [],
): BoardMatch | null {
	const term = boardQuery(query);
	if (!term) return null;
	const includes = (value: string): boolean => value.toLowerCase().includes(term);
	const text: BoardMatch['text'] = [];
	if (includes(item.description)) text.push('description');
	if (item.blockedOn && (includes(blockerName(item, items)) || includes(item.blockedOn.reason)))
		text.push('blocker');
	if (item.evidence.some(includes)) text.push('evidence');
	if (item.comments.some((comment) => includes(comment.body))) text.push('comments');
	const result: BoardMatch = { title: includes(item.title), owner: includes(item.owner), text };
	return result.title || result.owner || text.length ? result : null;
}
