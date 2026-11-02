import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { tabForKey } from '../src/desktop/maintenance-tabs.ts';

/*
 * The maintenance dialog's two tabs (card 32f030f9). The drawing and the focus are verified in the
 * built window (summon has no DOM in bun:test); held here are the key rule and the parts of the
 * markup contract that a later edit could quietly undo.
 */
const html = await Bun.file(join(import.meta.dir, '../src/desktop/index.html')).text();
const dialog = html.slice(html.indexOf('<dialog id="maintenance"'), html.indexOf('</dialog>'));
const between = (start: string, end: string): string =>
	dialog.slice(dialog.indexOf(start), dialog.indexOf(end));

describe('tabForKey', () => {
	test('arrows move between the two tabs and wrap', () => {
		expect(tabForKey('person', 'ArrowRight')).toBe('team');
		expect(tabForKey('team', 'ArrowRight')).toBe('person');
		expect(tabForKey('person', 'ArrowLeft')).toBe('team');
		expect(tabForKey('team', 'ArrowLeft')).toBe('person');
	});

	test('Home and End go to the ends, and other keys are left alone', () => {
		expect(tabForKey('team', 'Home')).toBe('person');
		expect(tabForKey('person', 'End')).toBe('team');
		for (const key of ['Tab', 'Enter', ' ', 'ArrowDown', 'a'])
			expect(tabForKey('person', key)).toBeUndefined();
	});
});

describe('the dialog markup', () => {
	test('is a tablist of two tabs, each controlling a labelled panel', () => {
		expect(dialog).toContain('role="tablist"');
		for (const name of ['person', 'team']) {
			const tab = dialog.slice(dialog.indexOf(`id="maint-tab-${name}"`));
			expect(tab.slice(0, tab.indexOf('>'))).toContain(`aria-controls="maint-panel-${name}"`);
			const panel = dialog.slice(dialog.indexOf(`id="maint-panel-${name}"`));
			const opening = panel.slice(0, panel.indexOf('>'));
			expect(opening).toContain('role="tabpanel"');
			expect(opening).toContain(`aria-labelledby="maint-tab-${name}"`);
		}
	});

	test('folds nothing away', () => {
		expect(dialog).not.toContain('<details');
		expect(dialog).not.toContain('<summary');
	});

	test('keeps team-wide controls on Team and the teammate form on Person', () => {
		const team = between('id="maint-panel-team"', 'id="maint-panel-person"');
		const person = dialog.slice(dialog.indexOf('id="maint-panel-person"'));
		for (const id of [
			'maint-cli-setup',
			'maint-wake-mentions',
			'maint-claude-live',
			'maint-auto-hold',
			'maint-hold-seconds',
			'maint-show-coverage',
			'maint-show-progress',
			'maint-show-delivery',
			'maint-light-theme',
		]) {
			expect(team).toContain(`id="${id}"`);
			expect(person).not.toContain(`id="${id}"`);
		}
		for (const id of ['maint-member', 'maint-form', 'maint-usage-refresh', 'maint-removal']) {
			expect(person).toContain(`id="${id}"`);
			expect(team).not.toContain(`id="${id}"`);
		}
		// Nothing team-wide is hidden while adding: only the teammate picker is.
		expect(team).not.toContain('data-maintenance-only');
	});

	test('puts the team switches above the long CLI comparison', () => {
		const order = [
			'id="maint-wake-mentions"',
			'id="maint-auto-hold"',
			'id="maint-show-coverage"',
			'id="maint-show-progress"',
			'id="maint-show-delivery"',
			'id="maint-cli-setup"',
		].map((marker) => dialog.indexOf(marker));
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	test('puts the required fields before Optional, and removal last', () => {
		const order = [
			'id="maint-name"',
			'id="maint-provider"',
			'id="maint-cwd"',
			'id="maint-optional"',
			'id="maint-expertise"',
			'id="maint-notes"',
			'id="maint-usage-refresh"',
			'id="maint-removal"',
		].map((marker) => dialog.indexOf(marker));
		expect(order.every((at) => at > 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	test('offers Team settings beside Add teammate, outside the dialog', () => {
		const entry = html.slice(html.indexOf('class="roster-entry"'), html.indexOf('id="roster"'));
		expect(entry).toContain('id="roster-add"');
		expect(entry).toContain('id="team-settings"');
	});
});
