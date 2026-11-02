/**
 * Bring the card Jump asked for into view (card e6619a2e): scrolled to, opened, focused and
 * marked the way a referenced Room message is, so the eye lands where the keyboard did.
 * @param root The Board panel.
 * @param id The card's full id.
 */
export function revealBoardCard(root: HTMLElement, id: string): void {
	root.querySelector('.board-jump-target')?.classList.remove('board-jump-target');
	const card = [...root.querySelectorAll<HTMLElement>('.board-card')].find(
		(candidate) => candidate.dataset['id'] === id,
	);
	if (!card) return;
	card.classList.add('board-jump-target');
	const control = card.querySelector<HTMLElement>('.board-card-disclosure');
	if (control?.getAttribute('aria-expanded') === 'false') control.click();
	// A card with nothing to open has no control; the card itself takes focus then.
	const target = control ?? card;
	if (!control) card.tabIndex = -1;
	target.focus({ preventScroll: true });
	card.scrollIntoView({ block: 'center', inline: 'center' });
}

/** Replace changed board data without interrupting the operator's reading position. */
export function replaceBoardLanes(root: HTMLElement, lanes: HTMLElement[]): void {
	const cards = [...root.querySelectorAll<HTMLElement>('.board-card')];
	const expanded = new Set(
		cards
			.filter((card) => card.querySelector('[aria-expanded="true"]') !== null)
			.map((card) => card.dataset['id']),
	);
	const active = document.activeElement;
	// Focus inside the lanes is restored after the swap. Focus in the search row is not touched at
	// all: that row is never replaced, and moving the caret out of a field someone is typing in
	// would be the redraw eating their input.
	const focused =
		active instanceof HTMLElement && root.contains(active) && !active.closest('.board-toolbar')
			? active
			: null;
	const focusedCard = focused?.closest<HTMLElement>('.board-card')?.dataset['id'];
	const focusedLane = focused?.closest<HTMLElement>('.board-lane')?.dataset['state'];
	const move = focused?.dataset['boardMove'];
	const disclosure = focused?.classList.contains('board-card-disclosure') ?? false;
	const scroll = { left: root.scrollLeft, top: root.scrollTop };
	const laneScroll = new Map(
		[...root.querySelectorAll<HTMLElement>('.board-lane')].map((lane) => [
			lane.dataset['state'],
			{ left: lane.scrollLeft, top: lane.scrollTop },
		]),
	);
	/*
	 * The lanes go in a grid of their own so the heading is not one of its items. A heading has to
	 * span the full width, and a grid item spanning every track is exactly what stops `auto-fit`
	 * collapsing the empty ones - which cost the six lanes a third of the panel (#4694).
	 *
	 * Only that grid is swapped. The heading and the search row above it stay where they are, as the
	 * same nodes: a node taken out of the document loses focus even if it is put straight back, so
	 * replacing every child and re-adding the survivors would drop the caret out of the search field
	 * on each refresh.
	 */
	const grid = document.createElement('div');
	grid.className = 'board-lanes';
	grid.append(...lanes);
	root.querySelector(':scope > .board-lanes')?.remove();
	root.append(grid);
	let focusTarget: HTMLElement | null = null;
	for (const card of root.querySelectorAll<HTMLElement>('.board-card')) {
		if (expanded.has(card.dataset['id'])) {
			const details = card.querySelector<HTMLElement>('.board-card-details');
			const control = card.querySelector('.board-card-disclosure');
			if (details && control) {
				details.hidden = false;
				control.setAttribute('aria-expanded', 'true');
			}
		}
		if (card.dataset['id'] === focusedCard && focusedCard !== undefined) {
			focusTarget = disclosure
				? card.querySelector('.board-card-disclosure')
				: ([...card.querySelectorAll<HTMLElement>('[data-board-move]')].find(
						(button) => button.dataset['boardMove'] === move,
					) ?? null);
		}
	}
	for (const lane of lanes) {
		const position = laneScroll.get(lane.dataset['state']);
		if (position) {
			lane.scrollLeft = position.left;
			lane.scrollTop = position.top;
		}
		if (focusedCard === undefined && lane.dataset['state'] === focusedLane)
			focusTarget = lane.querySelector('.board-lane-help');
	}
	if (focused !== null)
		(focusTarget ?? document.getElementById('board-toggle'))?.focus({ preventScroll: true });
	root.scrollLeft = scroll.left;
	root.scrollTop = scroll.top;
}
