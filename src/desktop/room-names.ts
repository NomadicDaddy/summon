import type { OperatorIdentity } from '../operator-identity-model.ts';
import type { TeamAgent } from './types.ts';

interface RoomName {
	id: string;
	human: boolean;
}

function styleName(node: HTMLElement, name: RoomName): void {
	node.className = name.human ? 'room-name room-name-human' : 'room-name';
	if (!name.human) {
		let hash = 0;
		for (const character of name.id.toLowerCase())
			hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
		// Resolve through CSS so existing sender and mention nodes follow a theme switch.
		node.style.color = `var(--room-name-${hash % 16})`;
	}
}

/** One name found in a line, with the text exactly as it was written. */
export interface RoomNameMatch {
	/** Where it starts in the line, so the caller can split around it. */
	at: number;
	/** `all` for the broadcast name, otherwise the slug the name belongs to. */
	id: string;
	label: string;
	kind: 'agent' | 'all' | 'human';
}

/**
 * Which names a line mentions, decided once and without a DOM.
 *
 * Separate from the rendering below because this is the part with an obvious wrong answer and the
 * part worth testing: whether @operator counts, whether @operators does not, whether the word
 * operator in ordinary prose does not. Proving any of that through the rendered element means
 * standing up a document first, and the decision never needed one.
 */
export function roomNameMatcher(
	agents: Pick<TeamAgent, 'name' | 'slug'>[],
	operator?: OperatorIdentity,
): (value: string) => RoomNameMatch[] {
	const names = new Map<string, RoomName>();
	for (const agent of agents) {
		for (const label of [agent.slug, agent.name]) {
			if (label.trim()) names.set(label.toLowerCase(), { id: agent.slug, human: false });
		}
	}
	// Personal names may match prose; common role words require @ (#4975). Diary-only shorthand
	// never becomes a Room name. Agents win even if an unvalidated caller passes a collision.
	const human: RoomName = { id: 'operator', human: true };
	const mentionOnly = new Set<string>();
	for (const label of operator
		? [operator.display, ...operator.aliases, ...operator.mentionOnly]
		: []) {
		const key = label.toLowerCase();
		if (names.has(key)) continue;
		names.set(key, human);
		if (operator?.mentionOnly.some((item) => item.toLowerCase() === key)) mentionOnly.add(key);
	}

	const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const longestFirst = (left: string, right: string) => right.length - left.length;
	/*
	 * An empty group is left out rather than written as `@(?:)`, which matches a bare `@` and would
	 * start marking punctuation the moment a list emptied. Neither list can be empty today, which is
	 * exactly why it is worth refusing to build: the version that breaks only in a future state is
	 * the version nobody notices has broken.
	 */
	const group = (keys: string[], prefix: string): string[] =>
		keys.length === 0 ? [] : [`${prefix}(?:${keys.sort(longestFirst).map(escape).join('|')})`];
	const alternatives = [
		'@all',
		...group([...mentionOnly], '@'),
		...group(
			[...names.keys()].filter((name) => !mentionOnly.has(name)),
			'@?',
		),
	];
	const pattern = new RegExp(
		`(?<![\\p{L}\\p{N}_@])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_-])`,
		'giu',
	);
	return (value) =>
		[...value.matchAll(pattern)].map((match) => {
			const label = match[0];
			if (label.toLowerCase() === '@all')
				return { at: match.index, id: 'all', kind: 'all', label };
			const name = names.get(label.replace(/^@/, '').toLowerCase());
			return {
				at: match.index,
				id: name?.id ?? '',
				kind: name?.human === true ? 'human' : 'agent',
				label,
			};
		});
}

/** Text nodes only: messages and roster names are never interpreted as HTML. */
export function roomNames(agents: Pick<TeamAgent, 'name' | 'slug'>[], operator?: OperatorIdentity) {
	const matcher = roomNameMatcher(agents, operator);
	return {
		sender: (node: HTMLElement, id: string, human: boolean): void => {
			styleName(node, { id, human });
		},
		text: (node: HTMLElement, value: string): void => {
			const fragments: (string | HTMLElement)[] = [];
			let offset = 0;
			for (const match of matcher(value)) {
				fragments.push(value.slice(offset, match.at));
				const marked = document.createElement('strong');
				marked.textContent = match.label;
				if (match.kind === 'all') marked.className = 'room-name room-name-all';
				else styleName(marked, { id: match.id, human: match.kind === 'human' });
				fragments.push(marked);
				offset = match.at + match.label.length;
			}
			fragments.push(value.slice(offset));
			node.replaceChildren(...fragments);
		},
	};
}
