import { buildCardDetails } from './board-card-details.ts';
import { dismissOnOutsideClick } from './dialog-dismiss.ts';
import { reportFault } from './fault-report.ts';
import { linkReferences, setupRoomReferences } from './room-references.ts';

/** Read the current card, including archived cards, without changing the selected teammate. */
export function setupDiaryLinks(root: HTMLElement): void {
	setupRoomReferences(root, (node, text) => {
		node.textContent = text;
		linkReferences(node);
	});
	const dialog = document.createElement('dialog');
	dialog.className = 'room-reference-dialog';
	dialog.setAttribute('aria-label', 'Referenced Board card');
	dismissOnOutsideClick(dialog);
	const close = document.createElement('button');
	close.textContent = 'Close';
	close.addEventListener('click', () => dialog.close());
	const content = document.createElement('article');
	dialog.append(close, content);
	document.body.append(dialog);
	let request = 0;
	dialog.addEventListener('close', () => {
		request++;
	});
	root.addEventListener('click', (event) => {
		if (!(event.target instanceof Element)) return;
		const link = event.target.closest<HTMLAnchorElement>('a[data-board-reference]');
		if (!link) return;
		event.preventDefault();
		const current = ++request;
		content.textContent = 'Loading Board card…';
		if (!dialog.open) dialog.showModal();
		void window.team
			.boardRead()
			.then((snapshot) => {
				if (current !== request) return;
				const card = snapshot.items.find((item) => item.id === link.dataset.boardReference);
				if (!card) throw new Error('Board card not found.');
				const title = document.createElement('h3');
				title.textContent = card.title;
				const meta = document.createElement('p');
				meta.textContent = `${card.owner} · ${card.state}${card.archived ? ' · archived' : ''}`;
				content.replaceChildren(title, meta, buildCardDetails(card));
			})
			.catch(() => {
				if (current === request) {
					content.textContent = 'Board card could not be loaded.';
					reportFault({
						level: 'error',
						source: 'diary.card',
						text: content.textContent,
					});
				}
			});
	});
}
