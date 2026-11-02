import type { BoardItem } from '../board-model.ts';
import type { BoardMove } from './types.ts';

import { buildCardDetails } from './board-card-details.ts';
import { dismissOnOutsideClick } from './dialog-dismiss.ts';

export const laneHelp: Record<BoardItem['state'], string> = {
	backlog:
		'Proposed or deferred work. Unresolved blockers are retained. It is not in the startable queue.',
	ready: 'Assigned work that the owner can pick up next.',
	doing: 'Work the owner has started.',
	blocked: 'Work waiting on a recorded person, task or external condition.',
	review: 'Work presented for your review. Accept it as done or return it to Backlog.',
	done: 'Completed work with evidence or a recorded operator acceptance.',
};

export const actionHelp: Record<BoardMove, { label: string; detail: string }> = {
	approve: {
		label: 'Accept as done',
		detail: 'Accept this card as completed and move it to Done. Tell the owner in Team Room. If no evidence is attached, record your acceptance as evidence; this does not claim that tests passed.',
	},
	promote: {
		label: 'Move to Ready',
		detail: 'Approve starting this card within its stated scope and move it from Backlog to Ready. Tell the owner in Team Room. This does not mark the work completed.',
	},
	unblock: {
		label: 'Allow work',
		detail: 'Approve proceeding within this card’s stated scope, clear its human blocker and move it to Ready. Tell the owner in Team Room. This does not mark the work completed.',
	},
	backlog: {
		label: 'Return to backlog',
		detail: 'Return this card to the proposed work queue. Keep its blocker, owner, evidence and history. Deferring work does not resolve what it is waiting on. No message is sent, and running work is not stopped. Tell the owner separately if work must stop or needs changes.',
	},
	archive: {
		label: 'Archive card',
		detail: 'Hide this card from the board and startable queue. Keep its current state, blocker, evidence and history. This neither accepts nor rejects the work, sends no message and does not stop a running session. Restore it through the CLI.',
	},
};

/*
 * The card's identifying line - project, owner, state, revision - read as prose because it shared
 * .board-action-dialog p with the two explanation paragraphs below it: same size, leading and
 * colour. It is metadata, so it takes the muted treatment S12 gave board metadata rather than the
 * mint the sweep proposed; S12 owns that value and this must not restate it.
 */
function meta(text: string): HTMLParagraphElement {
	const node = paragraph(text);
	node.className = 'board-card-meta';
	return node;
}

function paragraph(text: string): HTMLParagraphElement {
	const node = document.createElement('p');
	node.textContent = text;
	return node;
}

function dialog(title: string): HTMLDialogElement {
	const node = document.createElement('dialog');
	node.className = 'board-action-dialog';
	dismissOnOutsideClick(node);
	node.setAttribute('aria-label', title);
	const heading = document.createElement('h2');
	heading.textContent = title;
	node.append(heading);
	document.body.append(node);
	node.addEventListener('close', () => node.remove(), { once: true });
	return node;
}

function closeButton(node: HTMLDialogElement, label: string): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.textContent = label;
	button.addEventListener('click', () => node.close());
	return button;
}

export function showLaneHelp(state: BoardItem['state']): void {
	const node = dialog(`${state[0]?.toUpperCase() ?? ''}${state.slice(1)}`);
	node.append(paragraph(laneHelp[state]));
	const available: BoardMove[] = [
		...(state === 'review' ? (['approve'] as const) : []),
		...(state === 'backlog' ? (['promote'] as const) : []),
		...(state === 'blocked' || state === 'backlog' ? (['unblock'] as const) : []),
		...(state !== 'backlog' ? (['backlog'] as const) : []),
		'archive',
	];
	for (const move of available) {
		const heading = document.createElement('h3');
		heading.textContent = actionHelp[move].label;
		node.append(heading, paragraph(actionHelp[move].detail));
	}
	const notes = document.createElement('div');
	notes.className = 'board-action-notes';
	if (state === 'blocked' || state === 'backlog')
		notes.append(
			paragraph(
				`${state === 'backlog' ? 'Move to Ready appears on a card that has an owner and no blocker. ' : ''}Allow work appears only for a human blocker. Other blockers need their underlying condition resolved.`,
			),
		);
	notes.append(
		paragraph(
			'Actions that tell the owner can wake a stopped session when mention waking is enabled. Hibernated sessions stay asleep. A board decision does not release a separate mailbox approval hold.',
		),
	);
	node.append(notes);
	const close = closeButton(node, 'Close');
	const row = document.createElement('div');
	row.className = 'board-card-actions';
	row.append(close);
	node.append(row);
	node.showModal();
	close.focus();
}

export function confirmBoardAction(item: BoardItem, move: BoardMove): Promise<boolean> {
	const help = actionHelp[move];
	const node = dialog(help.label);
	const title = document.createElement('h3');
	title.textContent = item.title;
	node.append(
		title,
		meta(
			`${item.project || 'No project'} · ${item.owner || 'Unassigned'} · ${item.state} · revision ${item.revision}`,
		),
		buildCardDetails(item),
		paragraph(help.detail),
	);
	if (move === 'approve' || move === 'promote' || move === 'unblock')
		node.append(paragraph(WAKE_NOTE));
	if (move === 'archive')
		node.append(
			paragraph(
				`This card will remain ${item.state} in its history. Archiving does not delete it or free storage capacity.`,
			),
		);
	const cancel = closeButton(node, 'Cancel');
	const accept = document.createElement('button');
	accept.type = 'button';
	accept.dataset['boardConfirm'] = move;
	accept.className = 'primary';
	accept.textContent = help.label;
	const row = document.createElement('div');
	row.className = 'board-card-actions';
	row.append(cancel, accept);
	node.append(row);
	return new Promise((resolve) => {
		let confirmed = false;
		accept.addEventListener('click', () => {
			confirmed = true;
			node.close();
		});
		node.addEventListener('close', () => resolve(confirmed), { once: true });
		node.showModal();
		cancel.focus();
	});
}

const WAKE_NOTE =
	'The room notification can wake a stopped teammate it names; hibernated sessions stay asleep. Separate mailbox holds still need their own decision.';

export const OWNER_LABEL = 'Change owner';
export const OWNER_DETAIL =
	'Give this card to another registered teammate. Its state, blocker, evidence and history are kept. The new owner and the previous one are told in Team Room only when the card is already Ready or further; a Backlog card changes hands without a message.';

/** Asks which registered teammate takes the card. Resolves with a slug, or null when cancelled. */
export function chooseBoardOwner(
	item: BoardItem,
	teammates: { name: string; slug: string }[],
): Promise<null | string> {
	const node = dialog(OWNER_LABEL);
	const title = document.createElement('h3');
	title.textContent = item.title;
	const label = document.createElement('label');
	label.className = 'board-owner-choice';
	label.textContent = 'New owner';
	const select = document.createElement('select');
	// The current owner and the partner are left out: the first changes nothing and the store
	// refuses a card whose owner and partner are the same teammate.
	const choices = teammates.filter(
		(teammate) => teammate.slug !== item.owner && teammate.slug !== item.partner,
	);
	for (const teammate of choices) select.append(new Option(teammate.name, teammate.slug));
	label.append(select);
	node.append(
		title,
		meta(
			`${item.project || 'No project'} · ${item.owner || 'Unassigned'} · ${item.state} · revision ${item.revision}`,
		),
		paragraph(OWNER_DETAIL),
		// Only a card that is already work sends the notice, so only then is there a wake to warn of.
		...(item.state === 'backlog' ? [] : [paragraph(WAKE_NOTE)]),
		choices.length ? label : paragraph('No other registered teammate can take this card.'),
	);
	const cancel = closeButton(node, 'Cancel');
	const accept = document.createElement('button');
	accept.type = 'button';
	accept.dataset['boardConfirm'] = 'owner';
	accept.className = 'primary';
	accept.textContent = OWNER_LABEL;
	accept.disabled = choices.length === 0;
	const row = document.createElement('div');
	row.className = 'board-card-actions';
	row.append(cancel, accept);
	node.append(row);
	return new Promise((resolve) => {
		let chosen: null | string = null;
		accept.addEventListener('click', () => {
			chosen = select.value;
			node.close();
		});
		node.addEventListener('close', () => resolve(chosen), { once: true });
		node.showModal();
		(choices.length ? select : cancel).focus();
	});
}
