export function externalRoomUrl(value: unknown): string {
	if (typeof value !== 'string') throw new Error('Invalid web link.');
	const url = new URL(value);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
		throw new Error('Only HTTP(S) links without credentials can be opened.');
	return url.href;
}

export function roomLinks(text: string): { index: number; label: string; url: string }[] {
	const links: { index: number; label: string; url: string }[] = [];
	for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/giu)) {
		let label = match[0];
		let previous: string;
		do {
			previous = label;
			label = label.replace(/[.,;:!?]+$/u, '');
			for (const [open, close] of [
				['(', ')'],
				['[', ']'],
				['{', '}'],
			] as const) {
				while (
					label.endsWith(close) &&
					label.split(close).length > label.split(open).length
				)
					label = label.slice(0, -1);
			}
		} while (label !== previous);
		try {
			links.push({ index: match.index, label, url: externalRoomUrl(label) });
		} catch {
			// Invalid or credential-bearing URLs stay plain text.
		}
	}
	return links;
}

/** Construct text and anchors, never HTML, keeping name decoration outside complete URLs. */
export function renderRoomLinks(
	node: HTMLElement,
	text: string,
	decorate: (node: HTMLElement, value: string) => void,
	open: (url: string) => void,
): void {
	node.replaceChildren();
	let offset = 0;
	const appendText = (value: string): void => {
		const span = document.createElement('span');
		decorate(span, value);
		node.append(...span.childNodes);
	};
	for (const match of roomLinks(text)) {
		appendText(text.slice(offset, match.index));
		const link = document.createElement('a');
		link.href = match.url;
		link.textContent = match.label;
		link.title = 'Open in your browser';
		link.addEventListener('click', (event) => {
			event.preventDefault();
			open(match.url);
		});
		node.append(link);
		offset = match.index + match.label.length;
	}
	appendText(text.slice(offset));
}
