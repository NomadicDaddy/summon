import { expect, test } from 'bun:test';

import { memberSelection, selectionFocus } from '../src/desktop/selection-focus.ts';

function fixture(selected = 'ada', running = true) {
	let focused = 0;
	const target = { selected, running, terminal: { focus: () => focused++ } };
	return { target, current: () => target, count: () => focused };
}

function deferred() {
	let resolve: (value: boolean) => void = () => {};
	const promise = new Promise<boolean>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test('successful selection focuses the running terminal after selection resolves', async () => {
	const focus = selectionFocus();
	const view = fixture();
	expect(await focus.select('ada', () => Promise.resolve(true), view.current)).toBe(true);
	expect(view.count()).toBe(1);
});

test('failed selection never focuses the already selected terminal', async () => {
	const focus = selectionFocus();
	const view = fixture();
	expect(await focus.select('ada', () => Promise.resolve(false), view.current)).toBe(false);
	expect(view.count()).toBe(0);
});

test('offline member selection leaves row focus alone', async () => {
	const focus = selectionFocus();
	const view = fixture('ada', false);
	await focus.select('ada', () => Promise.resolve(true), view.current);
	expect(view.count()).toBe(0);
});

test('a successful selection with no terminal does not throw', async () => {
	const focus = selectionFocus();
	expect(
		await focus.select(
			'ada',
			() => Promise.resolve(true),
			() => ({
				selected: 'ada',
				running: true,
				terminal: undefined,
			}),
		),
	).toBe(true);
});

test('a snapshot selecting someone else cannot receive the requested focus', async () => {
	const focus = selectionFocus();
	const view = fixture('ivy');
	await focus.select('ada', () => Promise.resolve(true), view.current);
	expect(view.count()).toBe(0);
});

test('routine snapshots during a delayed selection cannot consume its focus request', async () => {
	const focus = selectionFocus();
	const view = fixture('ivy');
	const gate = deferred();
	const pending = focus.select('ada', () => gate.promise, view.current);
	// An unrelated snapshot arrives before the selection's own published snapshot.
	view.target.selected = 'ivy';
	expect(view.count()).toBe(0);
	view.target.selected = 'ada';
	expect(view.count()).toBe(0);
	gate.resolve(true);
	await pending;
	expect(view.count()).toBe(1);
	// Refreshes after completion have no callback that can steal the composer caret.
	view.target.selected = 'ivy';
	view.target.selected = 'ada';
	expect(view.count()).toBe(1);
});

test('a periodic snapshot cannot focus a pending selection even for the same member', async () => {
	const focus = selectionFocus();
	const view = fixture();
	const gate = deferred();
	const pending = focus.select('ada', () => gate.promise, view.current);
	expect(view.current().selected).toBe('ada');
	expect(view.count()).toBe(0);
	gate.resolve(false);
	await pending;
	expect(view.count()).toBe(0);
});

test('an older successful selection cannot focus after a newer click', async () => {
	const focus = selectionFocus();
	const view = fixture();
	const gate = deferred();
	const older = focus.select('ada', () => gate.promise, view.current);
	view.target.selected = 'ivy';
	await focus.select('ivy', () => Promise.resolve(true), view.current);
	expect(view.count()).toBe(1);
	view.target.selected = 'ada';
	gate.resolve(true);
	await older;
	expect(view.count()).toBe(1);
});

test('two clicks for the same slug still have separate request identities', async () => {
	const focus = selectionFocus();
	const view = fixture();
	const gate = deferred();
	const older = focus.select('ada', () => gate.promise, view.current);
	await focus.select('ada', () => Promise.resolve(true), view.current);
	expect(view.count()).toBe(1);
	gate.resolve(true);
	await older;
	expect(view.count()).toBe(1);
});

test('an older failure does not cancel a newer same-slug selection', async () => {
	const focus = selectionFocus();
	const view = fixture();
	const first = deferred();
	const second = deferred();
	const older = focus.select('ada', () => first.promise, view.current);
	const newer = focus.select('ada', () => second.promise, view.current);
	first.resolve(false);
	await older;
	expect(view.count()).toBe(0);
	second.resolve(true);
	await newer;
	expect(view.count()).toBe(1);
});

test('a failed newer selection does not revive an older pending request', async () => {
	const focus = selectionFocus();
	const view = fixture();
	const gate = deferred();
	const older = focus.select('ada', () => gate.promise, view.current);
	await focus.select('ivy', () => Promise.resolve(false), view.current);
	gate.resolve(true);
	await older;
	expect(view.count()).toBe(0);
});

test('a session stopped during selection receives no focus', async () => {
	const focus = selectionFocus();
	const view = fixture();
	const gate = deferred();
	const pending = focus.select('ada', () => gate.promise, view.current);
	view.target.running = false;
	gate.resolve(true);
	await pending;
	expect(view.count()).toBe(0);
});

test('selection controls share supersession across different surfaces', async () => {
	const view = fixture();
	const gate = deferred();
	const selected: string[] = [];
	const select = memberSelection((slug) => {
		selected.push(slug);
		return slug === 'ada' ? gate.promise : Promise.resolve(true);
	}, view.current);
	const rosterClick = () => select('ada');
	const repositorySwitch = () => select('ivy');
	const older = rosterClick();
	view.target.selected = 'ivy';
	await repositorySwitch();
	expect(selected).toEqual(['ada', 'ivy']);
	expect(view.count()).toBe(1);
	view.target.selected = 'ada';
	gate.resolve(true);
	await older;
	expect(view.count()).toBe(1);
});
