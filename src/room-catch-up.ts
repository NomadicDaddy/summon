import { cachedLocalEvents, type LocalEvent, localPage } from './local-room.ts';

const CATCH_UP_THRESHOLD = 100;
const RECENT_EXACT = 20;
const PAGE_LIMIT = 100;
const PAGE_BYTES = 26_000;
const EXCERPT_LENGTH = 240;

export interface CatchUpEvent extends LocalEvent {
	ownBodyOmitted?: true;
	digest?: { kind: 'excerpt'; originalCharacters: number; readOriginal: string };
}

// A connected reply thread is exact if any member needs protection. Resolve roots in
// history order (parents precede children) so later human replies also protect old parents.
function protectedThreads(history: LocalEvent[], name: string): Set<number> {
	const roots = new Map<number, number>();
	const protectedRoots = new Set<number>();
	for (const event of history) {
		const parent = event.replyTo === null ? undefined : history[event.replyTo - 1];
		const root = event.replyTo === null ? event.id : roots.get(event.replyTo);
		if (root === undefined) throw new Error('Missing catch-up reply context.');
		roots.set(event.id, root);
		if (
			event.sender.kind !== 'agent' ||
			event.image ||
			event.question ||
			event.answer ||
			event.id > history.length - RECENT_EXACT ||
			event.text.includes('@') ||
			event.text.toLowerCase().includes(name.toLowerCase()) ||
			(parent?.sender.kind === 'agent' && parent.sender.id === name)
		)
			protectedRoots.add(root);
	}
	return new Set(
		history
			.filter((event) => protectedRoots.has(roots.get(event.id) ?? event.id))
			.map((event) => event.id),
	);
}

export function checkpointRoomEvents(
	history: LocalEvent[],
	after: number,
	name: string,
): CatchUpEvent[] {
	if (!Number.isSafeInteger(after) || after < 0 || after > history.length)
		throw new Error('Invalid catch-up cursor.');
	const exact = protectedThreads(history, name);
	const catchUp = history.length - after >= CATCH_UP_THRESHOLD;
	return history.slice(after).map((original) => {
		let event: CatchUpEvent = original;
		if (!exact.has(original.id)) {
			if (original.sender.kind === 'agent' && original.sender.id === name)
				event = { ...original, text: '', ownBodyOmitted: true };
			else if (catchUp && original.text.length > EXCERPT_LENGTH)
				event = {
					...original,
					text: Array.from(original.text).slice(0, EXCERPT_LENGTH).join(''),
					digest: {
						kind: 'excerpt',
						originalCharacters: original.text.length,
						readOriginal: `summon --room read ${original.id - 1}`,
					},
				};
		}
		return event;
	});
}

export function catchUpPage(history: LocalEvent[], after: number, name: string) {
	const events: CatchUpEvent[] = [];
	let size = 0;
	for (const event of checkpointRoomEvents(history, after, name).slice(0, PAGE_LIMIT)) {
		const bytes = Buffer.byteLength(JSON.stringify(event));
		if (size + bytes > PAGE_BYTES) break;
		events.push(event);
		size += bytes;
	}
	if (!events.length && after < history.length)
		throw new Error('Room event exceeds catch-up byte limit; use an explicit room read.');
	return {
		events,
		nextCursor: events.at(-1)?.id ?? after,
		more: after + events.length < history.length,
		catchUp:
			'Older routine peer posts may be excerpts, not complete summaries. Read originals when needed. Receipt acknowledges this delivered digest only; it is not approval or task completion.',
	};
}

export async function compactLocalPage(after: number, name: string) {
	const history = await cachedLocalEvents();
	if (history.length - after >= CATCH_UP_THRESHOLD) return catchUpPage(history, after, name);
	const page = await localPage(after);
	return {
		...page,
		events: page.events.map((event) => ({
			...event,
			...(event.sender.kind === 'agent' && event.sender.id === name
				? { text: '', ownBodyOmitted: true as const }
				: {}),
		})),
	};
}
