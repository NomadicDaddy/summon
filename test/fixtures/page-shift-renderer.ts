import type { PageState } from '../../src/desktop/page-state.ts';
import type { RuntimeFaultInput } from '../../src/desktop/types.ts';

import { watchPageShift } from '../../src/desktop/page-shift.ts';

/*
 * The real watchPageShift in a real Chromium page (morgan and morticia on df84bdd: only the text
 * was tested). Each case drives one axis of one scroller and reads what was reported and sent.
 */
const fail = (reason: unknown) => {
	document.title = `FAIL: ${reason instanceof Error ? reason.message : String(reason)}`;
};
window.addEventListener('error', (event) => fail(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => fail(event.reason));
function assert(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
const reports: RuntimeFaultInput[] = [];
const count = (): number => reports.length;
/*
 * The watcher runs on the page's scroll event, which arrives with the next frame. On a loaded
 * machine that frame came later than a fixed 120 ms, and the fixture failed itself (gate on
 * 8d2561c, #13561). Wait for the n-th record, then settle, so one too many is still caught.
 */
const recorded = async (n: number): Promise<void> => {
	for (let waited = 0; count() < n && waited < 5000; waited += 20)
		await new Promise((resolve) => setTimeout(resolve, 20));
	await settle();
};

const style = document.createElement('style');
document.head.append(style);
const layout = (css: string) => {
	style.textContent = css;
};
const pane = document.createElement('div');
pane.id = 'pane';
pane.style.cssText = 'height:100px;overflow:auto';
pane.innerHTML = '<div style="height:2000px">tall pane</div>';
const input = document.createElement('input');
input.id = 'probe-input';
document.body.append(pane, input, Object.assign(document.createElement('div'), { id: 'big' }));

const sent: PageState[] = [];
// The root scrolls in both directions to start with.
layout('html, body { margin: 0 } #big { width: 4000px; height: 4000px }');
watchPageShift(
	(entry) => reports.push(entry),
	(state) => sent.push(state),
);
const run = async () => {
	assert(sent.length === 1 && sent[0]?.scrollY === 0, 'Initial layout not sent at start');
	assert(count() === 0, 'Reported with the page in place');
	const page = document.scrollingElement ?? document.documentElement;
	const inPlace = (label: string) =>
		assert(
			page.scrollTop === 0 &&
				page.scrollLeft === 0 &&
				document.body.scrollTop === 0 &&
				document.body.scrollLeft === 0,
			`${label}: the page was not put back`,
		);
	// A pane scrolling inside the page is not the page moving, and is left where it is.
	pane.scrollTop = 500;
	await settle();
	assert(count() === 0, 'An inner pane scroll was reported as the page moving');
	assert(pane.scrollTop === 500, 'An inner pane was scrolled back');
	// Root, vertical: recorded with what made the page tall, and put back.
	window.scrollTo(0, 500);
	await recorded(1);
	assert(count() === 1, `Root vertical: expected 1 record, got ${String(count())}`);
	assert(reports[0]?.source === 'window.page-shifted', 'Wrong source');
	assert(reports[0].text.includes('0, 500 px'), 'Root vertical offset missing');
	assert(
		reports[0].text.includes('furthest past the window: body, innermost div#big,'),
		`Tall elements not named: ${reports[0].text}`,
	);
	assert(reports[0].text.endsWith('It was put back in place.'), 'Put-back not said');
	inPlace('Root vertical');
	// Put back ends the episode, so moving again is recorded again.
	window.scrollTo(0, 800);
	await recorded(2);
	assert(count() === 2, 'A second move after the put-back was not recorded');
	assert(reports[1]?.text.includes('0, 800 px'), 'Second root offset missing');
	inPlace('Second root vertical');
	window.scrollTo(300, 0);
	await recorded(3);
	assert(count() === 3, 'Root horizontal not reported');
	assert(reports[2]?.text.includes('300, 0 px'), 'Root horizontal offset missing');
	inPlace('Root horizontal');
	// Body as the scroller (the root clips): both axes must be seen and put back.
	layout(
		'html { overflow: hidden; height: 100% } body { margin: 0; height: 100%; overflow: auto } #big { width: 4000px; height: 4000px }',
	);
	await settle();
	document.body.scrollLeft = 100;
	await recorded(4);
	assert(count() === 4, 'Body horizontal not reported');
	assert(reports[3]?.text.includes('100, 0 px'), 'Body horizontal offset missing');
	assert(
		reports[3]?.text.includes('nothing in it reaching past the window'),
		'An element clipped by body was named as reaching past the window',
	);
	inPlace('Body horizontal');
	input.focus();
	document.body.scrollTop = 250;
	await recorded(5);
	assert(count() === 5, 'Body vertical not reported');
	assert(reports[4]?.text.includes('0, 250 px'), 'Body vertical offset missing');
	assert(reports[4]?.text.includes('input#probe-input'), 'Focused element not named');
	inPlace('Body vertical');
	// The Team Window's own clip, with an absolutely placed element escaping body (#13294: the
	// journal's body was the window's size while the page moved 275 px).
	layout(
		'html { overflow: hidden } body { margin: 0; height: 100vh; overflow: clip } #big { width: 10px; height: 10px } #escape, #twin { position: absolute; top: 3000px; left: 0; width: 10px; height: 10px }',
	);
	// A later sibling at the same reach does not take the name: it is not inside the first (Morticia
	// on b79050a).
	document.body.append(
		Object.assign(document.createElement('div'), { id: 'escape' }),
		Object.assign(document.createElement('div'), { id: 'twin' }),
	);
	await settle();
	page.scrollTop = 275;
	await recorded(6);
	assert(count() === 6, 'The clipped page moving was not reported');
	assert(reports[5]?.text.includes('0, 275 px'), 'Clipped page offset missing');
	assert(
		reports[5]?.text.includes(
			'furthest past the window: div#escape, reaching 10 px across and 3010 px down',
		),
		`Escaping element not named: ${reports[5]?.text ?? ''}`,
	);
	inPlace('Clipped page');
	assert(reports[5]?.text.endsWith('It was put back in place.'), 'Put-back success not said');
	// A page that will not go back: the line says so, once for the whole episode (Roger on b79050a).
	Object.defineProperty(page, 'scrollTop', { configurable: true, get: () => 90, set: () => {} });
	window.dispatchEvent(new Event('scroll'));
	window.dispatchEvent(new Event('scroll'));
	await settle();
	assert(count() === 7, `A stuck page: expected 1 more record, got ${String(count() - 6)}`);
	assert(
		reports[6]?.text.endsWith('It could not be put back: it is still moved by 0, 90 px.'),
		`Failed put-back not said: ${reports[6]?.text ?? ''}`,
	);
	Reflect.deleteProperty(page, 'scrollTop');
	window.dispatchEvent(new Event('scroll'));
	await settle();
	inPlace('Released page');
	// Every change was sent to main, the moved layouts among them, and the latest is in place.
	assert(
		sent.some((state) => state.scrollY === 250),
		'A moved layout was not sent',
	);
	assert(sent.at(-1)?.scrollY === 0 && sent.at(-1)?.scrollX === 0, 'Latest layout not sent');
	assert(
		sent.every((state, n) => n === 0 || JSON.stringify(state) !== JSON.stringify(sent[n - 1])),
		'An unchanged layout was sent twice in a row',
	);
	document.title = 'PAGE_SHIFT_PASS';
};
void run().catch(fail);
