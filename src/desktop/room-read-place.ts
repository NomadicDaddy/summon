export interface RoomReadPlace {
	readThrough: number | null;
	leftAt: number | null;
}

const validId = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function roomPlaceKey(team: string | undefined): string {
	return `room-read-place:${team === undefined ? 'default' : `named:${encodeURIComponent(team)}`}`;
}

export function parseRoomPlace(raw: string | null): RoomReadPlace {
	if (raw === null) return { readThrough: null, leftAt: null };
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== 'object') throw new Error('Invalid saved Room place.');
	const place = value as Record<string, unknown>;
	if (
		!(place.readThrough === null || validId(place.readThrough)) ||
		!(place.leftAt === null || validId(place.leftAt))
	)
		throw new Error('Invalid saved Room place.');
	return { readThrough: place.readThrough, leftAt: place.leftAt };
}

export function saveRoomPlace(
	storage: Pick<Storage, 'setItem'>,
	team: string | undefined,
	place: RoomReadPlace,
): void {
	storage.setItem(roomPlaceKey(team), JSON.stringify(place));
}

/** A partial message is never evidence of having reached its end. */
export function lastFullyVisibleMessage(messages: HTMLElement): number | null {
	const viewport = messages.getBoundingClientRect();
	let last: number | null = null;
	for (const item of messages.querySelectorAll<HTMLElement>(
		'article.room-message[data-room-id]',
	)) {
		const bounds = item.getBoundingClientRect();
		const id = Number(item.dataset.roomId);
		if (
			validId(id) &&
			bounds.height > 0 &&
			bounds.top >= viewport.top &&
			bounds.bottom <= viewport.bottom
		)
			last = id;
	}
	return last;
}

export function setupRoomReadPlace(
	messages: HTMLElement,
	badge: HTMLElement,
	report: (message: string) => void,
): {
	selectTeam: (team: string | undefined) => Promise<void>;
	mark: (id: number) => Promise<void>;
	captureLeave: () => void;
	returnToLeftOff: () => boolean;
	refresh: () => Promise<void>;
	redraw: () => void;
} {
	const element = (id: string): HTMLElement => {
		const node = document.getElementById(id);
		if (!node) throw new Error(`Missing Room place element ${id}`);
		return node;
	};
	const status = element('room-read-status');
	const first = element('room-first-unread') as HTMLButtonElement;
	const left = element('room-left-off') as HTMLButtonElement;
	const markVisible = element('room-mark-visible') as HTMLButtonElement;
	let team: string | undefined;
	let selected = false;
	let valid = true;
	let place: RoomReadPlace = { readThrough: null, leftAt: null };
	let unread = 0;
	let firstUnread: number | null = null;
	let known = false;
	let generation = 0;
	let refreshSerial = 0;
	const jump = (id: number): void => {
		messages.dispatchEvent(new CustomEvent('room-place-jump', { detail: id }));
	};
	const redraw = (): void => {
		messages.querySelector('.room-first-unread-divider')?.remove();
		messages.querySelector('.room-left-off-marker')?.remove();
		status.textContent = !valid
			? 'Saved Room place is invalid or unavailable. No read claim was made.'
			: place.readThrough === null
				? 'No read marker yet.'
				: !known
					? `Saved read marker #${place.readThrough} is outside readable history; place unknown.`
					: `Read through #${place.readThrough} · ${unread} unread post${unread === 1 ? '' : 's'}`;
		badge.textContent = valid && known && unread > 0 ? String(unread) : '';
		first.disabled = !valid || firstUnread === null;
		left.disabled = !valid || place.leftAt === null;
		markVisible.disabled = !valid;
		if (!valid) return;
		if (firstUnread !== null) {
			const item = document.getElementById(`room-message-${firstUnread}`);
			if (item && messages.contains(item)) {
				const divider = document.createElement('div');
				divider.className = 'room-first-unread-divider';
				divider.textContent = 'First unread';
				item.before(divider);
			}
		}
		if (place.leftAt !== null) {
			const target = document.getElementById(`room-message-${place.leftAt}`);
			const item = target?.closest('article.room-message');
			if (item && messages.contains(item)) {
				const marker = document.createElement('div');
				marker.className = 'room-left-off-marker';
				marker.textContent = 'You left off here';
				item.prepend(marker);
			}
		}
	};
	const sync = async (): Promise<void> => {
		const current = ++refreshSerial;
		const selectedGeneration = generation;
		if (!valid || place.readThrough === null) {
			known = false;
			firstUnread = null;
			unread = 0;
			redraw();
			return;
		}
		try {
			const result = await window.team.roomUnread(place.readThrough);
			if (current !== refreshSerial || selectedGeneration !== generation) return;
			known = result.known;
			firstUnread = result.firstUnread;
			unread = result.unread;
			if (!known) report('Saved Room read marker is outside readable history.');
		} catch (cause: unknown) {
			if (current !== refreshSerial || selectedGeneration !== generation) return;
			known = false;
			firstUnread = null;
			unread = 0;
			report(`Room unread count failed: ${String(cause)}`);
		}
		redraw();
	};
	const persist = (next: RoomReadPlace): boolean => {
		try {
			saveRoomPlace(localStorage, team, next);
			if (next.readThrough !== place.readThrough) generation++;
			place = next;
			redraw();
			return true;
		} catch (cause: unknown) {
			report(`Room place was not saved: ${String(cause)}`);
			return false;
		}
	};
	const mark = async (id: number): Promise<void> => {
		if (!selected || !valid || !validId(id)) return;
		const selectedGeneration = generation;
		try {
			const page = await window.team.roomRead(id - 1);
			if (selectedGeneration !== generation) return;
			if (!page.events.some((event) => event.id === id))
				throw new Error(`Message #${id} is no longer readable.`);
			if (persist({ ...place, readThrough: id })) await sync();
		} catch (cause: unknown) {
			report(`Room read marker unchanged: ${String(cause)}`);
		}
	};
	markVisible.addEventListener('click', () => {
		const id = lastFullyVisibleMessage(messages);
		if (id === null) report('No whole Room message is visible to mark read.');
		else void mark(id);
	});
	first.addEventListener('click', () => {
		if (firstUnread !== null) jump(firstUnread);
	});
	left.addEventListener('click', () => {
		if (place.leftAt !== null) jump(place.leftAt);
	});
	return {
		selectTeam: async (name) => {
			if (selected && team === name) return;
			team = name;
			selected = true;
			generation++;
			known = false;
			firstUnread = null;
			unread = 0;
			try {
				place = parseRoomPlace(localStorage.getItem(roomPlaceKey(team)));
				valid = true;
			} catch (cause: unknown) {
				valid = false;
				report(`Saved Room place cannot be read: ${String(cause)}`);
			}
			await sync();
		},
		mark,
		captureLeave: () => {
			if (!selected || !valid) return;
			const id = lastFullyVisibleMessage(messages);
			if (id !== null && id !== place.leftAt) persist({ ...place, leftAt: id });
		},
		returnToLeftOff: () => {
			if (!selected || !valid || place.leftAt === null) return false;
			jump(place.leftAt);
			return true;
		},
		refresh: sync,
		redraw,
	};
}
