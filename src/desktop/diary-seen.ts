interface SeenEntry {
	id: string;
	at: string;
}

const KEY = 'diary-last-seen';

function read(): SeenEntry | null {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
		if (
			value !== null &&
			typeof value === 'object' &&
			'id' in value &&
			typeof value.id === 'string' &&
			'at' in value &&
			typeof value.at === 'string' &&
			Number.isFinite(Date.parse(value.at))
		)
			return { id: value.id, at: value.at };
	} catch {
		/* Storage may be unavailable; this visit still works. */
	}
	return null;
}

export function setupDiarySeen(
	panel: HTMLElement,
	list: HTMLElement,
): {
	open: () => void;
	close: () => void;
	refresh: () => void;
	filter: (filtered: boolean) => void;
} {
	let saved = read();
	let boundary = saved;
	let candidate: SeenEntry | null = null;
	let active = false;
	let filtered = false;
	const label = document.createElement('p');
	label.className = 'diary-seen-status';
	panel.insertBefore(label, list);
	const marker = document.createElement('li');
	marker.className = 'diary-last-seen';
	marker.textContent = 'Last seen — newer entries above';
	const observer = new IntersectionObserver(
		(entries) => {
			if (!active || filtered) return;
			for (const item of entries) {
				if (!item.isIntersecting || item.intersectionRatio < 0.5) continue;
				const node = item.target as HTMLElement;
				if (!list.contains(node)) continue;
				const { diaryId: id, diaryAt: at } = node.dataset;
				if (id && at && (!candidate || at > candidate.at)) candidate = { id, at };
			}
		},
		{ root: panel, threshold: 0.5 },
	);
	const refresh = (): void => {
		marker.remove();
		label.hidden = filtered;
		if (filtered) return;
		label.textContent = boundary
			? `Last seen ${new Date(boundary.at).toLocaleString()} · marker at your previous visit`
			: 'First visit · visible entries will be remembered';
		for (const node of list.querySelectorAll<HTMLElement>('[data-diary-id]')) {
			observer.observe(node);
			if (node.dataset.diaryId === boundary?.id) list.insertBefore(marker, node);
		}
	};
	const close = (): void => {
		if (!active) return;
		active = false;
		observer.disconnect();
		if (candidate && (!saved || candidate.at >= saved.at)) {
			saved = candidate;
			try {
				localStorage.setItem(KEY, JSON.stringify(saved));
			} catch {
				/* Keep in memory. */
			}
		}
	};
	window.addEventListener('beforeunload', close);
	return {
		open: () => {
			active = true;
			boundary = saved;
			candidate = null;
			refresh();
		},
		close,
		refresh,
		filter: (value) => {
			filtered = value;
			observer.disconnect();
			refresh();
		},
	};
}
