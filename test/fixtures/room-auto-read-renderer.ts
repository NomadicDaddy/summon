// The Room read-place renderer fixture, with the Window's focus and visibility under the test's
// control: `window.roomAttend` decides what `document.hasFocus()` and `visibilityState` report, so
// each reading condition is set on purpose rather than left to how an offscreen window happens to
// report focus. The import runs first; the patch still lands before auto-read's first 250 ms tick.
import './room-read-place-renderer.ts';

const control = window as unknown as { roomAttend: boolean };
control.roomAttend = false;
Object.defineProperty(document, 'hasFocus', { value: () => control.roomAttend });
Object.defineProperty(document, 'visibilityState', {
	get: () => (control.roomAttend ? 'visible' : 'hidden'),
});
