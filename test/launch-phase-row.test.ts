import { expect, test } from 'bun:test';

import type { LabelMotionDeps } from '../src/desktop/state-label-motion.ts';
import type { TeamAgent } from '../src/desktop/types.ts';
import type { LaunchPhaseView } from '../src/launch-phase-model.ts';

import { launchEndedNote, launchLabel, launchTooltip } from '../src/desktop/launch-phase-label.ts';
import {
	headerState,
	memberStateLabel,
	memberWorkingText,
} from '../src/desktop/member-identity.ts';
import { activitySummary, observationUnavailable } from '../src/desktop/observation-unavailable.ts';
import {
	LAUNCH_WALK_MS,
	stateLabelMoves,
	writeLabelMotion,
} from '../src/desktop/state-label-motion.ts';

/*
 * The roster's launch-phase rules (card 0674e3b6), covered here rather than in the Electron probe.
 * The probe proves what the row looks like; these are the precedence decisions, each with an
 * obvious wrong answer: a phase that outranks Busy, a stale "Ready" task under a phase, a phase on a
 * session another window owns, or a tooltip that claims a sign-in.
 */
const view = (over: Partial<LaunchPhaseView> = {}): LaunchPhaseView => ({
	evidence: 'owned-process-spawn',
	phase: 'connecting',
	since: '2026-10-06T23:50:00.000Z',
	...over,
});
const agent = (over: Partial<TeamAgent> = {}): TeamAgent => ({
	activity: 'idle',
	canManageHeadDown: false,
	coveredBy: '',
	cwd: 'D:/work',
	domain: '',
	memberType: 'teammate',
	name: 'Probe',
	ownedSession: true,
	provider: 'claude',
	slug: 'probe',
	status: 'running',
	unreadMail: 0,
	workingOn: '',
	...over,
});

test('a phase replaces the idle fallback with its own wording', () => {
	expect(memberStateLabel(agent({ launch: view() }))).toBe('Connecting…');
	expect(memberStateLabel(agent({ launch: view({ phase: 'logging-in' }) }))).toBe('Logging in…');
	expect(memberStateLabel(agent({ launch: view({ phase: 'startup' }) }))).toBe('Summon startup…');
	expect(memberStateLabel(agent())).toBe('Ready');
});

test('Busy and Needs you are things the member said and outrank any phase', () => {
	expect(memberStateLabel(agent({ activity: 'busy', launch: view() }))).toBe('Busy');
	expect(memberStateLabel(agent({ activity: 'needs-user', launch: view() }))).toBe('Needs you');
});

test('a phase belongs to the owned running session only', () => {
	for (const status of ['elsewhere', 'exited', 'stopped', 'offline', 'hibernated'] as const) {
		expect(launchLabel(agent({ launch: view(), status }))).toBeUndefined();
	}
	expect(memberStateLabel(agent({ launch: view(), status: 'exited' }))).toBe('Session ended');
});

test('no stale task shows under a phase, whatever the record says', () => {
	expect(memberWorkingText(agent({ launch: view(), workingOn: 'Ready' }))).toBe('');
	expect(memberWorkingText(agent({ launch: view(), workingOn: 'Reviewing last week' }))).toBe('');
	expect(memberWorkingText(agent({ workingOn: 'Reviewing last week' }))).toBe(
		'Reviewing last week',
	);
});

test('a provider limit is visible separately from process and turn state', () => {
	const limited = agent({
		provider: 'kilo',
		providerLimit: {
			provider: 'zai-coding-plan',
			status: 429,
			code: '1310',
			observedAt: '2026-11-08T18:05:59.000Z',
		},
	});
	expect(memberWorkingText(limited)).toBe('Provider limit observed');
	expect(memberStateLabel(limited)).toBe('Ready');
	expect(memberStateLabel({ ...limited, activity: 'busy' })).toBe('Busy');
});

test('the tooltip names the observation and never claims a sign-in', () => {
	const text = launchTooltip(view({ evidence: 'claude-mcp-initialized', phase: 'logging-in' }));
	expect(text).toContain('Logging in since');
	expect(text).toContain('Claude initialised its MCP connection.');
	expect(text).toContain('Sign-in is not checked by Summon');
	expect(text.toLowerCase()).not.toContain('signed in');
	expect(launchTooltip(view({ evidence: 'mail-readiness', phase: 'startup' }))).toContain(
		'Waiting for the first status call.',
	);
});

test('a session that ended before speaking says which phase it ended in', () => {
	const ended = view({ evidence: 'codex-session-start', phase: 'logging-in' });
	expect(launchEndedNote(agent({ launchEnded: ended, status: 'exited' }))).toBe(
		'Ended while logging in (Codex reported its session start.)',
	);
	expect(launchEndedNote(agent({ launchEnded: ended }))).toBe('');
	expect(launchEndedNote(agent({ status: 'exited' }))).toBe('');
});

test('the header agrees with the row: class for the ring, the same label, the phase tooltip', () => {
	const launching = headerState(agent({ launch: view() }), 'idle');
	expect(launching.className).toBe('running launch-connecting');
	expect(launching.label).toBe('Connecting…');
	expect(launching.title).toContain('Connecting since');
	expect(headerState(agent({ activity: 'busy', launch: view() }), 'busy')).toEqual({
		className: 'busy launch-connecting',
		label: 'Busy',
		title: launchTooltip(view()),
	});
	expect(headerState(agent({ launch: view(), status: 'exited' }), undefined)).toEqual({
		className: 'exited',
		label: 'Session ended',
		title: '',
	});
	expect(headerState(undefined, undefined)).toEqual({ className: '', label: '', title: '' });
});

/*
 * STATUS UNAVAILABLE: an owned running child whose record could not be read this snapshot. The
 * marker is a fact about the window's observation, so it outranks every claim the record might
 * have carried, and it fabricates nothing in their place.
 */
test('a session that is not running shows no Ready task line, and real task text stays', () => {
	// agent-activity clause 4: "Ready" was the loudest word under a stopped or offline teammate.
	for (const status of ['offline', 'stopped', 'hibernated', 'exited'] as const)
		expect(memberWorkingText(agent({ status, workingOn: 'Ready' }))).toBe('');
	expect(
		memberWorkingText(agent({ status: 'hibernated', workingOn: 'Paused for the weekend' })),
	).toBe('Paused for the weekend');
	// Running in another window, idle, Ready is true and stays; busy with no task keeps Ready too.
	expect(memberWorkingText(agent({ status: 'elsewhere', workingOn: 'Ready' }))).toBe('Ready');
	expect(memberWorkingText(agent({ activity: 'busy', workingOn: 'Ready' }))).toBe('Ready');
});

test('an unreadable owned running record says so and claims no state, task or phase', () => {
	const unread = agent({ observationUnavailable: true });
	expect(observationUnavailable(unread)).toBe(true);
	expect(memberStateLabel(unread)).toBe('Status unavailable');
	expect(memberWorkingText(unread)).toBe('');
	expect(memberWorkingText(agent({ observationUnavailable: true, workingOn: 'Ready' }))).toBe('');
	// Stale values that might ride along in a partial snapshot are not shown either.
	expect(memberStateLabel(agent({ activity: 'busy', observationUnavailable: true }))).toBe(
		'Status unavailable',
	);
	expect(memberStateLabel(agent({ launch: view(), observationUnavailable: true }))).toBe(
		'Status unavailable',
	);
	expect(memberWorkingText(agent({ observationUnavailable: true, workingOn: 'Old task' }))).toBe(
		'',
	);
});

test('the header shows the same unavailable label with its explanation and no phase ring', () => {
	const header = headerState(agent({ launch: view(), observationUnavailable: true }), 'busy');
	expect(header.className).toBe('running');
	expect(header.label).toBe('Status unavailable');
	expect(header.title).toContain('could not be read');
	expect(header.title).not.toContain('Connecting');
});

test('the Maintenance activity line reads as before, or names only what was observed', () => {
	expect(activitySummary(agent({ activity: 'busy', unreadMail: 2, workingOn: 'Fixing' }))).toBe(
		'running · busy · Fixing · 2 unread mail',
	);
	expect(activitySummary({ ownedSession: true, status: 'running' })).toBe(
		'running · idle · No task reported · 0 unread mail',
	);
	expect(activitySummary(agent({ observationUnavailable: true }))).toBe(
		'running · Status unavailable',
	);
	// A stopped member keeps its readable line; the marker means nothing there.
	expect(activitySummary(agent({ observationUnavailable: true, status: 'stopped' }))).toBe(
		'stopped · idle · No task reported · 0 unread mail',
	);
});

test('the marker applies to the owned running child only', () => {
	expect(observationUnavailable(agent({ observationUnavailable: true, status: 'stopped' }))).toBe(
		false,
	);
	expect(
		observationUnavailable(agent({ observationUnavailable: true, status: 'elsewhere' })),
	).toBe(false);
	expect(
		observationUnavailable(agent({ observationUnavailable: true, ownedSession: false })),
	).toBe(false);
	expect(memberStateLabel(agent({ observationUnavailable: true, status: 'stopped' }))).toBe(
		'Stopped by operator',
	);
	expect(memberStateLabel(agent())).toBe('Ready');
});

test('letters walk on a shown launch phase and on compacting, and nowhere else', () => {
	// One minute into the fixture launch unless a case says otherwise.
	const began = Date.parse(view().since);
	const moves = (over: Partial<TeamAgent>, now = began + 60_000): boolean => {
		const member = agent(over);
		return stateLabelMoves(member, memberStateLabel(member), launchLabel(member), now);
	};
	for (const phase of ['connecting', 'logging-in', 'startup'] as const)
		expect(moves({ launch: view({ phase }) })).toBe(true);
	expect(moves({ nativeCompacting: true })).toBe(true);
	// A reported state wins the label, so the phase underneath it does not animate it.
	expect(moves({ activity: 'busy', launch: view() })).toBe(false);
	expect(moves({ activity: 'needs-user', launch: view() })).toBe(false);
	// Settled states, and a phase left on a session that is no longer running.
	expect(moves({})).toBe(false);
	expect(moves({ activity: 'busy' })).toBe(false);
	expect(moves({ status: 'exited', launch: view() })).toBe(false);
	expect(moves({ status: 'offline' })).toBe(false);
	expect(stateLabelMoves(undefined, 'Connecting…', 'Connecting…', began)).toBe(false);
	// The Resting label is written over a phase by the rest roster; it holds still.
	expect(stateLabelMoves(agent({ launch: view() }), 'Resting', 'Connecting…', began)).toBe(false);
	// A phase that has outlasted a normal launch is stuck: the word stays and stops walking.
	expect(moves({ launch: view({ phase: 'startup' }) }, began + LAUNCH_WALK_MS - 1)).toBe(true);
	expect(moves({ launch: view({ phase: 'startup' }) }, began + LAUNCH_WALK_MS)).toBe(false);
	expect(moves({ launch: view({ since: 'not a time' }) })).toBe(false);
	// Compacting is not a launch and is not timed.
	expect(moves({ nativeCompacting: true }, began + 10 * LAUNCH_WALK_MS)).toBe(true);
});

/*
 * The roster redraws only when its snapshot changes, and a stuck launch changes nothing, so the
 * cap cannot wait for a redraw (roger #11278, morticia #11275). A fake clock stands in for the
 * window's timers: the label is drawn once and never again, and must still stop at the bound.
 */
function fakeMotion(start: number) {
	const writes: { active: boolean; text: string }[] = [];
	const timers = new Map<number, { at: number; stop: () => void }>();
	let clock = start;
	let next = 0;
	const deps: LabelMotionDeps = {
		cancel: (handle) => timers.delete(handle as unknown as number),
		now: () => clock,
		schedule: (stop, delay) => {
			next += 1;
			timers.set(next, { at: clock + delay, stop });
			return next as unknown as ReturnType<typeof setTimeout>;
		},
		write: (_element, text, active) => writes.push({ active, text }),
	};
	const advanceTo = (time: number): void => {
		clock = time;
		for (const [handle, timer] of [...timers])
			if (timer.at <= time) {
				timers.delete(handle);
				timer.stop();
			}
	};
	return { advanceTo, deps, timers, writes };
}

test('an unchanged launch label drawn once stops walking at the bound with no redraw', () => {
	const began = Date.parse(view().since);
	const motion = fakeMotion(began + 60_000);
	const element = {} as HTMLElement;
	const member = agent({ launch: view({ phase: 'startup' }) });
	writeLabelMotion(element, member, 'Summon startup…', launchLabel(member), motion.deps);
	expect(motion.writes).toEqual([{ active: true, text: 'Summon startup…' }]);
	motion.advanceTo(began + LAUNCH_WALK_MS - 1);
	expect(motion.writes).toHaveLength(1);
	motion.advanceTo(began + LAUNCH_WALK_MS);
	expect(motion.writes.at(-1)).toEqual({ active: false, text: 'Summon startup…' });
	expect(motion.timers.size).toBe(0);
});

test('a redraw replaces the pending stop, and settled labels and Compacting schedule none', () => {
	const began = Date.parse(view().since);
	const motion = fakeMotion(began + 60_000);
	const element = {} as HTMLElement;
	const member = agent({ launch: view() });
	writeLabelMotion(element, member, 'Connecting…', launchLabel(member), motion.deps);
	writeLabelMotion(element, member, 'Connecting…', launchLabel(member), motion.deps);
	expect(motion.timers.size).toBe(1);
	// The teammate reports Busy: the label settles and the old stop must not fire over it.
	writeLabelMotion(
		element,
		agent({ activity: 'busy', launch: view() }),
		'Busy',
		undefined,
		motion.deps,
	);
	expect(motion.timers.size).toBe(0);
	const compacting = agent({ nativeCompacting: true });
	writeLabelMotion({} as HTMLElement, compacting, 'Compacting…', undefined, motion.deps);
	expect(motion.writes.at(-1)).toEqual({ active: true, text: 'Compacting…' });
	expect(motion.timers.size).toBe(0);
	motion.advanceTo(began + 10 * LAUNCH_WALK_MS);
	expect(motion.writes.at(-1)).toEqual({ active: true, text: 'Compacting…' });
});
