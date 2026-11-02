import { expect, test } from 'bun:test';

/*
 * The roster is rebuilt on every changed snapshot. Member and rest buttons already kept keyboard
 * focus through that; the head-down Yes and No did not, so a keyboard user answering a request was
 * dropped to <body> whenever any teammate changed state. The window probe proves the behaviour;
 * this pins the wiring that makes it.
 */
test('a focused head-down answer survives a roster rebuild', async () => {
	const [roster, renderer] = await Promise.all([
		Bun.file('src/desktop/head-down-roster.ts').text(),
		Bun.file('src/desktop/renderer.ts').text(),
	]);
	expect(roster).toContain("button.dataset.headDownDecision = approve ? 'approve' : 'decline';");
	expect(roster).toContain('export function focusedHeadDown(');
	expect(roster).toContain('export function restoreHeadDownFocus(');
	const capture = renderer.indexOf('const focusedDecision = focusedHeadDown(roster);');
	const rebuild = renderer.indexOf('roster.replaceChildren();');
	const restore = renderer.indexOf('restoreHeadDownFocus(roster, focusedDecision);');
	expect(capture).toBeGreaterThan(-1);
	expect(capture).toBeLessThan(rebuild);
	expect(restore).toBeGreaterThan(rebuild);
});
