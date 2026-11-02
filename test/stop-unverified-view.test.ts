import { describe, expect, test } from 'bun:test';

import type { StopResult, TeamAgent } from '../src/desktop/types.ts';

import { headerState, memberStateLabel, rowStateTitle } from '../src/desktop/member-identity.ts';
import { UNAVAILABLE_NOTE } from '../src/desktop/observation-unavailable.ts';
import { PROVIDER_TURN_TITLE } from '../src/desktop/provider-working.ts';
import { stopWithConfirm } from '../src/desktop/stop-confirm.ts';
import {
	renderStopButton,
	STOP_UNVERIFIED,
	STOP_UNVERIFIED_TITLE,
	stopUnverifiedNotes,
	stopUnverifiedTitle,
} from '../src/desktop/stop-unverified-view.ts';

/*
 * The Window's consumers of an unverified Stop (Phillip #25640 on #25639): one label on every state
 * surface, a title that names no process count, and a Stop button that can't be pressed again.
 */
const running: TeamAgent = {
	slug: 'alpha',
	name: 'Alpha',
	provider: 'codex',
	cwd: '.',
	status: 'running',
	activity: 'busy',
	ownedSession: true,
};
const unverified: TeamAgent = { ...running, stopUnverified: true };

/** Just the surface renderStopButton writes: the disabled attribute, its text and title. */
function fakeButton() {
	const attributes = new Set<string>();
	return {
		attributes,
		textContent: 'Stop Session',
		title: '',
		toggleAttribute(name: string, force: boolean) {
			if (force) attributes.add(name);
			else attributes.delete(name);
			return force;
		},
	};
}

// Morgan's review of 5a106a9: the row labelled Stop unverified but its tooltip still explained an
// ordinary provider turn. The row's tooltip now follows the label's order, as the header's does.
describe('roster row tooltip', () => {
	test('a provider-busy row with an unverified stop explains the stop', () => {
		// Provider-busy means the provider reports a turn the teammate hasn't (provider-working.ts).
		const busy: TeamAgent = { ...running, activity: 'idle', providerTurn: 'busy' };
		expect(rowStateTitle(busy)).toBe(PROVIDER_TURN_TITLE);
		expect(rowStateTitle({ ...busy, stopUnverified: true })).toBe(STOP_UNVERIFIED_TITLE);
	});
	test('so does a row whose observation is unavailable', () => {
		const unreadable: TeamAgent = { ...running, observationUnavailable: true };
		expect(rowStateTitle(unreadable)).toBe(UNAVAILABLE_NOTE);
		expect(rowStateTitle({ ...unreadable, stopUnverified: true })).toBe(STOP_UNVERIFIED_TITLE);
	});
	test('label and tooltip agree on every unverified row', () => {
		for (const agent of [unverified, { ...unverified, providerTurn: 'busy' as const }]) {
			expect(memberStateLabel(agent)).toBe(STOP_UNVERIFIED);
			expect(rowStateTitle(agent)).toBe(STOP_UNVERIFIED_TITLE);
		}
	});
	test('an ordinary idle row has no state tooltip', () => {
		expect(rowStateTitle({ ...running, activity: 'idle' })).toBe('');
	});
});

describe('state label', () => {
	test('an unverified stop reads Stop unverified, ahead of Busy', () => {
		expect(memberStateLabel(running)).toBe('Busy');
		expect(memberStateLabel(unverified)).toBe(STOP_UNVERIFIED);
	});
	test('it outranks an unreadable observation and a provider turn too', () => {
		expect(memberStateLabel({ ...unverified, observationUnavailable: true })).toBe(
			STOP_UNVERIFIED,
		);
		expect(memberStateLabel({ ...unverified, providerTurn: 'busy' })).toBe(STOP_UNVERIFIED);
	});
	test('the header shows the same label and explains it without a count', () => {
		const header = headerState(unverified, 'busy');
		expect(header.label).toBe(STOP_UNVERIFIED);
		expect(header.title).toBe(STOP_UNVERIFIED_TITLE);
		expect(header.title).not.toMatch(/\d/);
	});
	test('a settled stop goes back to the ordinary label and title', () => {
		const stopped: TeamAgent = {
			slug: 'alpha',
			name: 'Alpha',
			provider: 'codex',
			cwd: '.',
			status: 'stopped',
		};
		const header = headerState(stopped, undefined);
		expect(header.label).not.toBe(STOP_UNVERIFIED);
		expect(header.title).toBe('');
	});
});

describe('Stop button', () => {
	test('disabled and relabelled while the stop is unverified', () => {
		const button = fakeButton();
		renderStopButton(button as unknown as HTMLElement, unverified);
		expect(button.attributes.has('disabled')).toBe(true);
		expect(button.textContent).toBe(STOP_UNVERIFIED);
		expect(button.title).toBe(STOP_UNVERIFIED_TITLE);
	});
	test('enabled as Stop Session again once the flag is gone', () => {
		const button = fakeButton();
		renderStopButton(button as unknown as HTMLElement, unverified);
		renderStopButton(button as unknown as HTMLElement, running);
		expect(button.attributes.has('disabled')).toBe(false);
		expect(button.textContent).toBe('Stop Session');
		expect(button.title).toBe('');
	});
});

const unchecked: StopResult = { unverified: true, rootChecked: false, detail: 'taskkill 128' };
const checked: StopResult = { unverified: true, rootChecked: true, detail: 'taskkill 128' };

describe('root not checked', () => {
	test('the title says so only when team:stop answered rootChecked false', () => {
		const notes = stopUnverifiedNotes();
		notes.record('alpha', notes.generation('alpha'), unchecked);
		expect(notes.title(unverified)).toBe(stopUnverifiedTitle(true));
		expect(notes.title(unverified)).toContain("Its main process couldn't be checked.");
	});
	test('a checked root gets the plain explanation', () => {
		const notes = stopUnverifiedNotes();
		notes.record('alpha', notes.generation('alpha'), checked);
		expect(notes.title(unverified)).toBe(STOP_UNVERIFIED_TITLE);
	});
	test('no title at all once the flag is gone', () => {
		const notes = stopUnverifiedNotes();
		notes.record('alpha', notes.generation('alpha'), unchecked);
		expect(notes.title({ ...running, status: 'stopped' })).toBeUndefined();
	});
	test('a stopped or cancelled answer records nothing', () => {
		const notes = stopUnverifiedNotes();
		const generation = notes.generation('alpha');
		notes.record('alpha', generation, { stopped: true });
		notes.record('alpha', generation, undefined);
		expect(notes.title(unverified)).toBe(STOP_UNVERIFIED_TITLE);
		expect(notes.record('alpha', generation, { stopped: true })).toBe(false);
	});
});

// Morgan 27365e7b and 7307db24: each launch's attempt is journalled once, its note shows whichever
// of the answer and the snapshot comes first, and a replacement launch starts clean. The note
// assertions come before any return-value assertion, so a control on the old code fails on them.
describe('answers, snapshots and launches', () => {
	test('snapshot first, answer later: the note shows as soon as the answer is recorded', () => {
		const notes = stopUnverifiedNotes();
		const generation = notes.generation('alpha');
		expect(notes.title(unverified)).toBe(STOP_UNVERIFIED_TITLE);
		notes.record('alpha', generation, unchecked);
		expect(notes.title(unverified)).toBe(stopUnverifiedTitle(true));
	});
	test('answer first, flag later: the note is there when the flag shows', () => {
		const notes = stopUnverifiedNotes();
		notes.record('alpha', notes.generation('alpha'), unchecked);
		expect(notes.title(running)).toBeUndefined();
		expect(notes.title(unverified)).toBe(stopUnverifiedTitle(true));
	});
	test('one journal entry per attempt: a second answer in the same launch is not journalled', () => {
		const notes = stopUnverifiedNotes();
		const generation = notes.generation('alpha');
		notes.record('alpha', generation, unchecked);
		notes.record('alpha', generation, checked);
		expect(notes.title(unverified)).toBe(stopUnverifiedTitle(true));
		const again = stopUnverifiedNotes();
		const first = again.generation('alpha');
		expect(again.record('alpha', first, unchecked)).toBe(true);
		expect(again.record('alpha', first, checked)).toBe(false);
	});
	test('old unverified, then a new launch with no stopped snapshot between: the next stop is its own', () => {
		const notes = stopUnverifiedNotes();
		const old = notes.generation('alpha');
		notes.record('alpha', old, unchecked);
		notes.launch('alpha');
		// The replacement's flag (if a stale snapshot still shows it) carries no old note.
		expect(notes.title(unverified)).toBe(STOP_UNVERIFIED_TITLE);
		const next = notes.generation('alpha');
		expect(next).not.toBe(old);
		expect(notes.record('alpha', next, checked)).toBe(true);
		expect(notes.title(unverified)).toBe(STOP_UNVERIFIED_TITLE);
	});
	test('a late answer from the old launch is journalled but does not mark the replacement', () => {
		const notes = stopUnverifiedNotes();
		const old = notes.generation('alpha');
		notes.launch('alpha');
		expect(notes.record('alpha', old, unchecked)).toBe(true);
		expect(notes.title(unverified)).toBe(STOP_UNVERIFIED_TITLE);
		// The replacement's own first attempt is still journalled.
		expect(notes.record('alpha', notes.generation('alpha'), checked)).toBe(true);
	});
	test('another member: the note and the launch generation belong to their own member', () => {
		const notes = stopUnverifiedNotes();
		const beta: TeamAgent = { ...unverified, slug: 'beta', name: 'Beta' };
		notes.record('alpha', notes.generation('alpha'), unchecked);
		notes.launch('beta');
		expect(notes.title(beta)).toBe(STOP_UNVERIFIED_TITLE);
		expect(notes.title(unverified)).toBe(stopUnverifiedTitle(true));
	});
});

// An unverified answer is neither success nor an error. stopWithConfirm hands it back to the
// renderer as it is, with no second question, no throw and no second stop.
describe('stopWithConfirm', () => {
	const idle: TeamAgent = { ...running, provider: 'claude', activity: 'idle' };
	test('an unverified answer is returned without asking or stopping again', async () => {
		const calls: boolean[] = [];
		let asked = 0;
		const answer: StopResult = { unverified: true, rootChecked: false, detail: 'taskkill 128' };
		const result = await stopWithConfirm(
			idle,
			() => (asked++, true),
			(confirmed) => (calls.push(confirmed), Promise.resolve(answer)),
		);
		expect(result).toEqual(answer);
		expect(asked).toBe(0);
		expect(calls).toEqual([false]);
	});
	test('an unverified answer to the confirmed retry is returned as well', async () => {
		const calls: boolean[] = [];
		const answer: StopResult = { unverified: true, rootChecked: true, detail: 'taskkill 128' };
		const result = await stopWithConfirm(
			idle,
			() => true,
			(confirmed) => {
				calls.push(confirmed);
				return Promise.resolve(confirmed ? answer : { needsConfirm: true });
			},
		);
		expect(result).toEqual(answer);
		expect(calls).toEqual([false, true]);
	});
});
