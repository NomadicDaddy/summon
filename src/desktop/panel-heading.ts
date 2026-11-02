/**
 * The one heading the three work panels share.
 *
 * Board, Diary and Repos each answered this differently and Phillip said at room #4303 that they
 * looked like three people's work: Board carried an h2 in a bordered bar with a Close button at the
 * right, Diary an accent-coloured h3 tight to the top edge, and Repos no heading at all - you opened
 * it and met a bare search box.
 *
 * WHY BOARD HAD A CLOSE BUTTON, since it was not arbitrary: it was using `.room-header`, which
 * belongs to the Team Room, Maintenance and Macros - surfaces that are dialogs or dismissable, where
 * a Close is right. Borrowing their header brought their button with it. A work panel is not a
 * dialog. It is toggled from the sidebar, the sidebar button shows pressed while it is open, and
 * pressing it again is how it closes - so a second control for the same thing is one more thing to
 * read and one more thing to keep in step.
 */
export function prependPanelHeading(panel: HTMLElement, title: string): void {
	const heading = document.createElement('h2');
	heading.className = 'panel-heading';
	heading.textContent = title;
	panel.prepend(heading);
}
