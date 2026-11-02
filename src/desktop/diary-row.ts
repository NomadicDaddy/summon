import type { DiaryEntry } from '../diary.ts';
import type { OperatorIdentity } from '../operator-identity-model.ts';

import { forOperator } from '../diary-operator.ts';
import { marked } from './search-marks.ts';

/**
 * Drawing one diary entry: the line itself, and the marks on what was searched for (the marking
 * itself is shared with the Board, in search-marks.ts).
 *
 * It moved out of the panel module when the panel reached the 300-line cap. The split is a real
 * seam rather than a convenience: everything here decides what an entry LOOKS like, and everything
 * left behind decides which entries to ask for and when.
 */

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/*
 * No year in the line (#6376): the diary is read for recent work, and the year cost width on every
 * row while saying the same thing on almost all of them. The tooltip keeps the full date. The year
 * is formatted and then cut, NOT left out of the options: sv-SE without a year falls back to
 * day/month ("05/10"), which reads as May 10 to half the world.
 */
function stamp(instant: Date): string {
	return instant
		.toLocaleString('sv-SE', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
		})
		.replace(/^\d{4}-/, '');
}

function full(instant: Date): string {
	return instant.toLocaleString(undefined, { timeZoneName: 'short' });
}

/**
 * The date on the line is the WORK date when the entry carries one, and the recording time otherwise.
 *
 * A backfilled entry records work that happened before it was written down, so its `at` says when
 * the diary heard about it and `happenedAt` says when it happened. The line shows the latter: that
 * is the date the reader is scanning for. The tooltip names both, so recording order (which is what
 * the list is sorted by) stays explainable from the row.
 *
 * A day-only work date stays the string it was given. `new Date('2026-09-30')` is UTC midnight, and
 * formatting that in Chicago prints 09-29 - the previous day. The source knew only the day, so the
 * row shows exactly that day and nothing it did not know.
 */
function workTime(item: DiaryEntry): HTMLTimeElement {
	const time = document.createElement('time');
	const recorded = new Date(item.at);
	if (item.happenedAt === undefined) {
		time.dateTime = item.at;
		time.textContent = stamp(recorded);
		time.title = full(recorded);
		return time;
	}
	time.className = 'diary-work-date';
	time.dateTime = item.happenedAt;
	if (DAY_ONLY.test(item.happenedAt)) {
		time.textContent = item.happenedAt.slice(5);
		time.title = `Work date ${item.happenedAt} (day only) · Recorded ${full(recorded)}`;
		return time;
	}
	const happened = new Date(item.happenedAt);
	time.textContent = stamp(happened);
	time.title = `Work date ${full(happened)} · Recorded ${full(recorded)}`;
	return time;
}

/** Repaint only the recipient; preserve expanded tasks, focused links, order and literal data. */
export function updateDiaryOperator(
	who: HTMLElement,
	operator: OperatorIdentity | undefined,
): void {
	const author = who.querySelector('.diary-author');
	const recipient = who.dataset.recipient;
	if (!author || recipient === undefined) return;
	if (forOperator(recipient, operator)) who.replaceChildren(author);
	else {
		const forWhom = document.createElement('span');
		forWhom.className = 'diary-for';
		forWhom.textContent = recipient;
		who.replaceChildren(author, ' → ', forWhom);
	}
}

export function row(
	item: DiaryEntry,
	query: string,
	operator: OperatorIdentity | undefined,
): HTMLElement {
	const node = document.createElement('li');
	node.dataset.diaryId = item.id;
	// Recording time, not work date: the list is ordered and paged by `at`, and diary-seen reads this
	// to place its Last Seen line, so a backfilled entry must sort where it was recorded.
	node.dataset.diaryAt = item.at;
	const time = workTime(item);
	/*
	 * ONE LINE PER ENTRY: date, who did it, who it was for, what it was (#4578).
	 *
	 * "for Phillip" became an arrow because the word was the only thing separating two names and it
	 * cost more width than it earned. The pair travels as one span so the arrow can never be the
	 * last thing on a line with the name it points at on the next.
	 */
	const who = document.createElement('span');
	who.className = 'diary-who';
	who.dataset.recipient = item.for;
	const author = document.createElement('strong');
	author.className = 'diary-author';
	author.replaceChildren(...marked(item.author.id, query));
	who.append(author);
	updateDiaryOperator(who, operator);
	/*
	 * The task is a BUTTON because clicking it opens the entry (#4633). One line per entry is the
	 * default and the shortening is real, so there has to be a way to see the rest without hunting
	 * for a tooltip.
	 *
	 * A button rather than a clickable row for three reasons: the row already contains reference
	 * links, and a click target wrapping them would have to guess which one was meant; a button
	 * says what it is to a screen reader and carries aria-expanded; and it is reachable by keyboard
	 * without making every row a tab stop for people who only want the links.
	 */
	const task = document.createElement('button');
	task.type = 'button';
	task.className = 'diary-task';
	task.replaceChildren(...marked(item.task, query));
	task.setAttribute('aria-expanded', 'false');
	// The whole of it stays readable on hover too, because the line is what gets shortened, not the
	// entry. The title goes once the entry is open, where it would only repeat what is on screen.
	task.title = item.task;
	task.addEventListener('click', () => {
		const open = node.classList.toggle('is-open');
		task.setAttribute('aria-expanded', String(open));
		task.title = open ? '' : item.task;
	});
	node.append(time, who, task);
	// Each separator travels with the link it introduces. Appended loose, the two were separate
	// items in one inline flow, so a line could end on a dangling dot and start the next on the
	// link - which is what made a two-reference entry read as three ragged lines in #4348.
	const reference = (link: HTMLAnchorElement): HTMLElement => {
		const pair = document.createElement('span');
		pair.className = 'diary-ref';
		pair.append(' · ', link);
		return pair;
	};
	const refs = document.createElement('span');
	refs.className = 'diary-refs';
	node.append(refs);
	for (const id of item.room) {
		const link = document.createElement('a');
		link.href = `#room-message-${id}`;
		link.dataset.roomReference = String(id);
		// Bare #id, which is the convention the room already set everywhere - its own references,
		// its reply lines and its back links all read "#4503" and keep the word in the title. The
		// diary was the only place spending the extra five characters on every row (#4651).
		link.textContent = `#${id}`;
		link.title = `View room message #${id}`;
		refs.append(reference(link));
	}
	for (const id of item.board) {
		const link = document.createElement('a');
		link.href = `#board-card-${id}`;
		link.dataset.boardReference = id;
		link.textContent = `Board ${id.slice(0, 8)}`;
		link.title = `View Board card ${id}`;
		refs.append(reference(link));
	}
	return node;
}
