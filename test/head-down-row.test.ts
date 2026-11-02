import { expect, test } from 'bun:test';

import type { HeadDownView } from '../src/head-down-model.ts';

import {
	canPauseNotifications,
	headDownEditorKey,
	headDownRow,
} from '../src/desktop/head-down-row.ts';

/*
 * The roster's head-down rules, covered here rather than in the Electron probe.
 *
 * The probe proves what these look like - the ring around the dot, the red, the line that changes.
 * It is a poor place to prove WHEN each applies, because every combination needs a teammate in a
 * particular state and a session that is alive or not. These are the decisions themselves, and each
 * one has an obvious wrong answer that this is here to catch.
 */
const view = (over: Partial<HeadDownView> = {}): HeadDownView => ({
	completion: 'the gate is green',
	goal: 'finish the audit findings',
	id: 'e3b0c442-98fc-1fc1-9afb-f4c8996fb924',
	overdue: false,
	phase: 'active',
	...over,
});

test('a teammate not in head-down keeps its own status line and no marking', () => {
	const row = headDownRow('running', 'Reviewing the gate', undefined);
	expect(row).toEqual({ line: 'Reviewing the gate', overdue: false });
	expect(row.phase).toBeUndefined();
});

test('an active head-down shows the approved goal instead of the self-written status', () => {
	const row = headDownRow('running', 'Reviewing the gate', view());
	expect(row.line).toBe('finish the audit findings');
	expect(row.phase).toBe('active');
});

test('a pending request changes neither the line nor the colour', () => {
	const row = headDownRow('running', 'Reviewing the gate', view({ phase: 'requested' }));
	expect(row.line).toBe('Reviewing the gate');
	expect(row.overdue).toBe(false);
	expect(row.phase).toBe('requested');
});

test('an overdue heartbeat takes the roster red', () => {
	expect(headDownRow('running', 'anything', view({ overdue: true })).overdue).toBe(true);
});

test('exited wins over overdue, because only one of them is terminal', () => {
	expect(headDownRow('exited', 'anything', view({ overdue: true })).overdue).toBe(false);
});

test('a request that is somehow overdue still colours nothing', () => {
	const row = headDownRow('running', 'anything', view({ overdue: true, phase: 'requested' }));
	expect(row.overdue).toBe(false);
});

/*
 * Which goal an open End-reason editor belongs to.
 *
 * The case worth catching is not "head-down ended" - it is one teammate in head-down replaced by
 * ANOTHER one in head-down, where nothing about the phase changes and a draft reason would
 * otherwise ride across. The second and third of these are that case.
 */
test('an editor belongs to one teammate and one goal', () => {
	expect(headDownEditorKey('alpha', view())).toBe('alpha:e3b0c442-98fc-1fc1-9afb-f4c8996fb924');
});

test('switching to another teammate who is also in head-down changes the key', () => {
	expect(headDownEditorKey('alpha', view())).not.toBe(headDownEditorKey('beta', view()));
});

test('the same teammate beginning a second head-down changes the key', () => {
	const next = view({ id: '5d41402a-bc4b-4a76-b971-9d911017c592' });
	expect(headDownEditorKey('alpha', view())).not.toBe(headDownEditorKey('alpha', next));
});

test('nothing to edit without a teammate, a head-down, or an approved one', () => {
	expect(headDownEditorKey(undefined, view())).toBe('');
	expect(headDownEditorKey('alpha', undefined)).toBe('');
	expect(headDownEditorKey('alpha', view({ phase: 'requested' }))).toBe('');
});

/*
 * When the quiet-time control has something to offer.
 *
 * The button used to appear for any selected teammate and do nothing when pressed, because the
 * backend will not hold a pause for a session this window is not running. These are the two states
 * that look alike from the outside and are not: a session running somewhere else, which this window
 * cannot speak for, and one running here, which it can.
 */
test('the pause control belongs to a session this window is running', () => {
	expect(canPauseNotifications({ ownedSession: true, status: 'running' })).toBe(true);
});

test('nothing to pause for a teammate with no session here', () => {
	for (const status of ['offline', 'exited', 'stopped', 'hibernated'])
		expect(canPauseNotifications({ ownedSession: true, status })).toBe(false);
});

test('a session running in another window is that window to quiet, not this one', () => {
	expect(canPauseNotifications({ ownedSession: false, status: 'elsewhere' })).toBe(false);
	expect(canPauseNotifications({ ownedSession: false, status: 'running' })).toBe(false);
});

test('no teammate selected, nothing to offer', () => {
	expect(canPauseNotifications(undefined)).toBe(false);
});
