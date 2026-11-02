import { beforeEach, expect, test } from 'bun:test';

import type { RuntimeFaultInput } from '../src/desktop/types.ts';

import { setupErrorBanner } from '../src/desktop/error-banner.ts';
import { windowActions } from '../src/desktop/window-action.ts';

/*
 * The operator identity error against the window's own actions, through the real error banner.
 * Natively, a hand-broken settings/operator-identity.json showed its banner, the first click on a
 * teammate cleared it, and it never came back while the file stayed broken
 * (summon/.aidd/reports/jimmy/v1-accept/findings.md). The journal here is the bridge the banner
 * reports to, so a duplicate entry would show up as a second record.
 */
interface FakeElement {
	hidden: boolean;
	textContent: string;
	addEventListener: (type: string, listener: () => void) => void;
	click: () => void;
}

const IDENTITY = 'settings/operator-identity.json: Invalid operator identity JSON.';
let journal: RuntimeFaultInput[] = [];
let elements: Record<string, FakeElement> = {};

function fake(): FakeElement {
	const listeners: (() => void)[] = [];
	return {
		hidden: true,
		textContent: '',
		addEventListener: (_type, listener) => listeners.push(listener),
		click: () => {
			for (const listener of listeners) listener();
		},
	};
}

function setup(): ReturnType<typeof windowActions> {
	elements = { error: fake(), 'error-message': fake(), 'error-dismiss': fake() };
	const banner = setupErrorBanner((id) => elements[id] as unknown as HTMLElement);
	return windowActions(banner);
}

const shown = (): string | null =>
	elements.error?.hidden === false ? (elements['error-message']?.textContent ?? '') : null;

beforeEach(() => {
	journal = [];
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			dispatchEvent: () => true,
			team: {
				faultReport: (entry: RuntimeFaultInput) => {
					journal.push(entry);
					return Promise.resolve();
				},
			},
		},
	});
});

test('a successful action draws a still-current identity error again, without journalling it', async () => {
	const actions = setup();
	actions.operatorError(IDENTITY);
	expect(shown()).toBe(IDENTITY);
	expect(await actions.action(() => Promise.resolve())).toBe(true);
	expect(shown()).toBe(IDENTITY);
	actions.operatorError(IDENTITY);
	expect(shown()).toBe(IDENTITY);
	expect(journal).toEqual([]);
});

test('a failed action keeps the box for its own error and journals it once', async () => {
	const actions = setup();
	actions.operatorError(IDENTITY);
	expect(await actions.action(() => Promise.reject(new Error('Select failed.')))).toBe(false);
	expect(shown()).toBe('Select failed.');
	actions.operatorError(IDENTITY);
	expect(shown()).toBe('Select failed.');
	expect(journal.map((entry) => entry.source)).toEqual(['window.action']);
});

test('Dismiss hides the identity error until the next action, not on the next snapshot', async () => {
	const actions = setup();
	actions.operatorError(IDENTITY);
	elements['error-dismiss']?.click();
	expect(shown()).toBeNull();
	actions.operatorError(IDENTITY);
	expect(shown()).toBeNull();
	await actions.action(() => Promise.resolve());
	expect(shown()).toBe(IDENTITY);
	expect(journal).toEqual([]);
});

test('a recovered identity is not drawn again, and a new fault is', async () => {
	const actions = setup();
	actions.operatorError(IDENTITY);
	actions.operatorError(undefined);
	await actions.action(() => Promise.resolve());
	expect(shown()).toBeNull();
	const clash =
		'settings/operator-identity.json: Operator identity "carl" conflicts with registered member "carl".';
	actions.operatorError(clash);
	expect(shown()).toBe(clash);
	expect(journal).toEqual([]);
});
