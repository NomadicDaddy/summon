/**
 * Close a modal when the click lands outside it.
 *
 * `<dialog>` gives Escape for free and gives backdrop dismissal not at all, so every modal in this
 * window answered one of the two ways a person tries to leave. Phillip reported it at room #4302.
 *
 * TWO CONDITIONS, AND BOTH ARE NEEDED. The familiar one-liner for this tests only
 * `event.target === dialog`, which is true for the backdrop - but it is equally true for the
 * dialog's OWN PADDING, so a click on the frame a few pixels outside the content closes a form the
 * reader believed they had clicked inside. The geometry test alone is no better: a native `<select>`
 * popup can paint outside the dialog's box, and the maintenance form has several, so dismissing on
 * coordinates alone would shut the dialog when somebody picks a teammate from the list.
 *
 * Requiring both leaves exactly the backdrop: the event has to be on the dialog element itself AND
 * outside its rectangle.
 */
export function dismissOnOutsideClick(dialog: HTMLDialogElement, mayClose?: () => boolean): void {
	dialog.addEventListener('click', (event: MouseEvent) => {
		if (event.target !== dialog) return;
		const box = dialog.getBoundingClientRect();
		const inside =
			event.clientX >= box.left &&
			event.clientX <= box.right &&
			event.clientY >= box.top &&
			event.clientY <= box.bottom;
		// A keyboard-activated button reports 0,0, which sits outside most dialogs and would make
		// Enter on a focused control close the whole modal.
		if (inside || (event.clientX === 0 && event.clientY === 0)) return;
		// The same guard Escape and the close button already answer to. Dismissing by misclick is a
		// worse bug than the one being fixed if it throws away what somebody typed.
		if (mayClose && !mayClose()) return;
		dialog.close();
	});
}
