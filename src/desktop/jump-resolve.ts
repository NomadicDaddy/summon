/**
 * What a Jump entry could mean (card e6619a2e): a Room message by number, a Board card by the
 * start of its id, or a teammate by name. Nothing else is looked at - no message text, no card
 * text - so the box cannot become a way to search what it should not.
 *
 * The rule is "list, never guess". `8355` is a message number and may also start a card id; `ada`
 * may be a teammate and may start a card id. Each reading that holds is returned, labelled by
 * kind, and the reader picks. A leading `#` is the one thing that settles it: it means a message.
 */
export interface JumpCard {
	archived: boolean;
	id: string;
	owner: string;
	state: string;
	title: string;
}

export interface JumpPerson {
	name: string;
	slug: string;
}

export type JumpTarget =
	| { card: JumpCard; kind: 'card' }
	| { id: number; kind: 'room' }
	| { kind: 'person'; person: JumpPerson };

export interface JumpAnswer {
	/** More matches than are shown; the reader is told to type more. */
	more: number;
	/** Why nothing matched, in words, or empty when something did or nothing was typed. */
	nothing: string;
	/**
	 * Said when the entry could be a card id and the Board cannot answer yet, or could not be read.
	 * Without it "no card matches" and "cards were not looked at" would read the same.
	 */
	note: string;
	/** The entry could be a card id and the Board is still being read: too early to go anywhere. */
	pending: boolean;
	targets: JumpTarget[];
}

/** Whether the Board's cards are in hand: Jump reads them each time the box opens. */
export type JumpBoard = 'failed' | 'loading' | 'ready';

/** As many matches as fit under the field without the box becoming a second Board. */
export const JUMP_LIMIT = 8;

const BOARD_NOTE: Record<JumpBoard, string> = {
	failed: 'The Board could not be read, so card ids cannot be looked up.',
	loading: 'Reading the Board for card ids…',
	ready: '',
};

const text = (value: string): string => value.trim().toLowerCase();

/** A card id is hexadecimal with dashes; two characters is the least that says "an id". */
const cardShaped = (query: string): boolean => /^[0-9a-f-]{2,}$/.test(query);

/**
 * Resolve what was typed against the roster and the Board. Order within the answer is the order
 * of confidence, and it matters because Enter takes the first: a teammate named exactly this, a
 * teammate whose name starts with it, the message number, cards, then a name that merely contains
 * it. Names come before cards on purpose. Card ids are hexadecimal and so are the first letters of
 * several names: on the real Board "da" and "ed" each start a card id, and someone typing two
 * letters of Dave or Edgar means the teammate (Morticia #8601).
 */
export function resolveJump(
	raw: string,
	people: readonly JumpPerson[],
	cards: readonly JumpCard[],
	board: JumpBoard = 'ready',
): JumpAnswer {
	const query = text(raw);
	const none = { more: 0, note: '', pending: false, targets: [] };
	if (query === '') return { ...none, nothing: '' };
	const number = /^#?([1-9]\d*)$/.exec(query)?.[1];
	const room = number !== undefined && Number.isSafeInteger(Number(number));
	if (query.startsWith('#')) {
		return room
			? { ...none, nothing: '', targets: [{ id: Number(number), kind: 'room' }] }
			: { ...none, nothing: 'After # comes a Room message number.' };
	}
	// One rank per teammate, taken from whichever of name and slug matches best, so a teammate
	// reached two ways is still listed once.
	const rank = (person: JumpPerson): number => {
		const names = [text(person.name), person.slug.toLowerCase()];
		if (names.includes(query)) return 0;
		if (names.some((name) => name.startsWith(query))) return 1;
		return names.some((name) => name.includes(query)) ? 2 : 3;
	};
	const ranked = (wanted: number): JumpTarget[] =>
		people
			.filter((person) => rank(person) === wanted)
			.map((person): JumpTarget => ({ kind: 'person', person }));
	const targets: JumpTarget[] = [...ranked(0), ...ranked(1)];
	if (room) targets.push({ id: Number(number), kind: 'room' });
	const asCard = cardShaped(query);
	if (asCard && board === 'ready') {
		targets.push(
			...cards
				.filter((card) => card.id.toLowerCase().startsWith(query))
				.map((card): JumpTarget => ({ card, kind: 'card' })),
		);
	}
	targets.push(...ranked(2));
	const note = asCard ? BOARD_NOTE[board] : '';
	return {
		more: Math.max(0, targets.length - JUMP_LIMIT),
		// A miss is only called a miss once everything that could match has been looked at.
		nothing: targets.length === 0 && note === '' ? nothingFor(query) : '',
		note,
		pending: asCard && board === 'loading',
		targets: targets.slice(0, JUMP_LIMIT),
	};
}

/** Says what was tried, so a miss reads as an answer rather than an empty box. */
function nothingFor(query: string): string {
	return cardShaped(query)
		? `No teammate is named ${query} and no card id starts with it.`
		: `No teammate is named ${query}. A card is found by the start of its id, a Room message by its number.`;
}

/** What makes two matches the same match, across a redraw of the list. */
export function jumpKey(target: JumpTarget): string {
	if (target.kind === 'room') return `room:${String(target.id)}`;
	return target.kind === 'card' ? `card:${target.card.id}` : `person:${target.person.slug}`;
}

/** Enter pressed while the Board was still being read, with no particular match meant. */
export const HELD_ENTER = 'enter';

/**
 * What a choice made during the Board read comes to once the read has ended: the match to go to,
 * or -1 to stay open and let the reader choose (Roger #8606, Morticia #8607).
 *
 * The reader chose before they could see everything, so the choice is honoured only where it
 * cannot have meant something else. A clicked match is that match, if it is still listed. An Enter
 * goes only when the read succeeded and exactly one thing matched: two cards under the same
 * prefix, or a message number that turns out to start a card id, are for the reader to pick
 * between. After a failed read nothing goes by itself, so the failure is seen rather than hidden
 * behind a jump to the message.
 * @param held HELD_ENTER, a clicked match's key, or null when nothing was chosen.
 * @param keys The keys of the matches now listed, in order.
 * @param board How the read ended.
 * @returns An index into `keys`, or -1.
 */
export function heldChoice(held: null | string, keys: readonly string[], board: JumpBoard): number {
	if (held === null || board !== 'ready') return -1;
	if (held === HELD_ENTER) return keys.length === 1 ? 0 : -1;
	return keys.indexOf(held);
}

/** One line for a target, as the list shows it and as a screen reader hears it. */
export function jumpLabel(target: JumpTarget): { detail: string; kind: string; title: string } {
	if (target.kind === 'room')
		return { detail: 'Team Room', kind: 'Message', title: `#${String(target.id)}` };
	if (target.kind === 'person')
		return { detail: '', kind: 'Teammate', title: target.person.name };
	const { card } = target;
	const where = [card.owner || 'no owner', card.archived ? 'archived' : card.state];
	return {
		detail: `${card.id.slice(0, 8)} · ${where.join(' · ')}`,
		kind: 'Card',
		title: card.title,
	};
}
