import { expect, test } from 'bun:test';

import type { TeamMacro } from '../src/team-macros.ts';

import { setupMacros } from '../src/desktop/macros.ts';
import { editorDom } from './fixtures/editor-dom.ts';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

const settled = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

function harness() {
	const loads: ReturnType<typeof deferred<TeamMacro[]>>[] = [];
	const alerts: string[] = [];
	let confirmations = 0;
	const dom = editorDom({
		confirm: () => {
			confirmations++;
			return false;
		},
		alert: (text: string) => alerts.push(text),
		team: {
			macros: () => {
				const load = deferred<TeamMacro[]>();
				loads.push(load);
				return load.promise;
			},
			faultReport: () => Promise.resolve(),
		},
	});
	setupMacros();
	const dialog = dom.body.querySelector('dialog');
	if (!dialog) throw new Error('Missing editor');
	return { ...dom, dialog, loads, alerts, confirmations: () => confirmations };
}

test('one opening load populates the dialog, and another click cannot replace edited rows', async () => {
	const h = harness();
	try {
		h.toggle.dispatchEvent(new Event('click'));
		h.loads[0]?.resolve([{ text: 'saved', send: false }]);
		await settled();
		expect(h.dialog.open).toBe(true);
		const text = h.dialog.querySelector('textarea');
		if (!text) throw new Error('No loaded slot');
		expect(text.value).toBe('saved');
		text.value = 'unsaved';
		h.toggle.dispatchEvent(new Event('click'));
		await settled();
		expect(h.loads).toHaveLength(1);
		expect(h.dialog.querySelector('textarea')).toBe(text);
		expect(text.value).toBe('unsaved');
		for (const kind of ['close', 'cancel', 'backdrop']) {
			if (kind === 'close')
				h.dialog.querySelector('#macros-close')?.dispatchEvent(new Event('click'));
			else if (kind === 'cancel') {
				const cancel = new Event('cancel', { cancelable: true });
				h.dialog.dispatchEvent(cancel);
				expect(cancel.defaultPrevented).toBe(true);
			} else {
				const click = new Event('click');
				Object.assign(click, { clientX: 200, clientY: 200 });
				h.dialog.dispatchEvent(click);
			}
			expect(h.dialog.open).toBe(true);
		}
		expect(h.confirmations()).toBe(3);
	} finally {
		h.restore();
	}
});

test('a delayed duplicate opening is suppressed before its response could overwrite new edits', async () => {
	const h = harness();
	try {
		h.toggle.dispatchEvent(new Event('click'));
		h.toggle.dispatchEvent(new Event('click'));
		h.loads[0]?.resolve([{ text: 'first', send: false }]);
		await settled();
		const text = h.dialog.querySelector('textarea');
		if (!text) throw new Error('No loaded slot');
		text.value = 'keep these edits';
		h.loads[1]?.resolve([{ text: 'late response', send: true }]);
		await settled();
		expect(h.dialog.querySelector('textarea')?.value).toBe('keep these edits');
		expect(h.dialog.querySelector('textarea')).toBe(text);
		expect(h.loads).toHaveLength(1);
	} finally {
		h.restore();
	}
});

test('failed loads can be retried, and a clean close allows a fresh opening', async () => {
	const h = harness();
	try {
		h.toggle.dispatchEvent(new Event('click'));
		h.loads[0]?.reject(new Error('load unavailable'));
		await settled();
		expect(h.alerts).toEqual(['load unavailable']);
		expect(h.dialog.open).toBe(false);
		h.toggle.dispatchEvent(new Event('click'));
		expect(h.loads).toHaveLength(2);
		h.loads[1]?.resolve([{ text: 'retry', send: true }]);
		await settled();
		h.dialog.querySelector('#macros-close')?.dispatchEvent(new Event('click'));
		expect(h.dialog.open).toBe(false);
		expect(h.toggle.focused).toBe(true);
		expect(h.confirmations()).toBe(0);
		h.toggle.dispatchEvent(new Event('click'));
		expect(h.loads).toHaveLength(3);
		h.loads[2]?.resolve([]);
		await settled();
		expect(h.dialog.open).toBe(true);
	} finally {
		h.restore();
	}
});
