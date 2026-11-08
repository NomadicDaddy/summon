import type { TeamAgent } from './types.ts';

import { headDownRow } from './head-down-row.ts';
import { labels, offlineTitle } from './hibernation-controls.ts';
import { connectingSince, markElapsed } from './launch-elapsed.ts';
import { launchEndedNote, launchLabel, launchTooltip } from './launch-phase-label.ts';
import { claudeAccountLabel, providerLimitFact } from './member-facts.ts';
import { memberIdentity } from './member-heading.ts';
import { COMPACTION_TITLE, nativeCompacting } from './native-compaction.ts';
import {
	observationUnavailable,
	UNAVAILABLE,
	UNAVAILABLE_NOTE,
} from './observation-unavailable.ts';
import {
	PROVIDER_TURN_TITLE,
	PROVIDER_TURN_UNKNOWN_TITLE,
	providerTurnUnknown,
	providerWorking,
} from './provider-working.ts';
import { writeLabelMotion } from './state-label-motion.ts';
import { STOP_UNVERIFIED, STOP_UNVERIFIED_TITLE } from './stop-unverified-view.ts';

function memberStatus(activity: string | undefined, fallback: string): string {
	return activity === 'busy' ? 'Busy' : activity === 'needs-user' ? 'Needs you' : fallback;
}

/**
 * One label for the row, the session header and the statusbar: Busy and Needs you first, then the
 * launch phase, then the session state, with an idle session that confirmed rest reading Resting.
 * A provider turn in progress reads Busy too, and any provider turn record, even one it cannot
 * read as idle, keeps the session from claiming Resting (provider-working.ts).
 */
export function memberStateLabel(agent: TeamAgent): string {
	// The operator's Stop outranks every other reading until the terminal's exit settles it.
	if (agent.stopUnverified) return STOP_UNVERIFIED;
	if (observationUnavailable(agent)) return UNAVAILABLE;
	if (nativeCompacting(agent)) return 'Compacting…';
	const online = agent.status === 'running' || agent.status === 'elsewhere';
	const activity = !online ? undefined : providerWorking(agent) ? 'busy' : agent.activity;
	const label = memberStatus(activity, launchLabel(agent) ?? labels[agent.status]);
	return label === labels.running && agent.restConfirmation && agent.providerTurn === undefined
		? 'Resting'
		: label;
}

/**
 * The session header's state in one place: its class (the session state, busy when self-reported
 * or the provider reports a turn, plus the launch phase for the ring), the same label the row
 * shows, and the tooltip naming where that state came from.
 */
export function headerState(
	agent: TeamAgent | undefined,
	activity: string | undefined,
): { className: string; label: string; title: string } {
	const unavailable = !!agent && observationUnavailable(agent);
	const compacting = !unavailable && nativeCompacting(agent);
	const working = !unavailable && !!agent && providerWorking(agent);
	const state =
		(activity === 'busy' || compacting || working) && !unavailable
			? 'busy'
			: (agent?.status ?? '');
	const launching =
		agent && !unavailable && !working && launchLabel(agent) ? agent.launch : undefined;
	return {
		className: [state, launching ? `launch-${launching.phase}` : ''].filter(Boolean).join(' '),
		label: agent ? memberStateLabel(agent) : '',
		title: headerTitle(agent, { compacting, launching, unavailable, working }),
	};
}

/** The header tooltip: the source of the state it shows, in the same order the label decides. */
function headerTitle(
	agent: TeamAgent | undefined,
	state: {
		compacting: boolean;
		launching: TeamAgent['launch'] | undefined;
		unavailable: boolean;
		working: boolean;
	},
): string {
	if (agent?.stopUnverified) return STOP_UNVERIFIED_TITLE;
	if (state.compacting) return COMPACTION_TITLE;
	if (state.working) return PROVIDER_TURN_TITLE;
	if (state.launching) return launchTooltip(state.launching);
	if (state.unavailable) return UNAVAILABLE_NOTE;
	if (agent && providerTurnUnknown(agent)) return PROVIDER_TURN_UNKNOWN_TITLE;
	if (agent?.status === 'unknown') return offlineTitle(agent);
	return '';
}

/** Write a state label; state-label-motion.ts decides whether its letters light in turn. */
export function writeStateLabel(
	element: HTMLElement,
	agent: TeamAgent | undefined,
	label = agent ? memberStateLabel(agent) : '',
): void {
	const launchWord = agent ? launchLabel(agent) : undefined;
	writeLabelMotion(element, agent, label, launchWord);
	const tone = stateTone(label);
	if (tone) element.dataset['tone'] = tone;
	else delete element.dataset['tone'];
}

/**
 * The colour a state word shares with its dot (Phillip #8525, #8530): Ready is the green of a
 * running session's dot and Busy the amber of a working one. Every other word stays neutral.
 */
export function stateTone(label: string): 'busy' | 'ready' | undefined {
	if (label === 'Busy') return 'busy';
	return label === labels.running ? 'ready' : undefined;
}

/** A teammate's self-reported task, or Ready when they have not set one or it says nothing. */
function statusText(value?: string): string {
	const task = value?.trim();
	return !task || /^(available|not set)$/i.test(task) ? 'Ready' : task;
}

/**
 * Omit a Ready task that repeats an idle session or contradicts one not running (agent-activity
 * clause 4). Under a launch phase the line is empty: that text is not something this launch said.
 */
export function memberWorkingText(agent: TeamAgent): string {
	if (observationUnavailable(agent) || launchLabel(agent)) return '';
	if (agent.providerLimit) return 'Provider limit observed';
	const task = statusText(agent.workingOn);
	const readyAddsNothing =
		agent.status === 'running' ? agent.activity === 'idle' : agent.status !== 'elsewhere';
	return readyAddsNothing && task === 'Ready' ? '' : task;
}

/**
 * The roster row's state tooltip, explaining whichever state its label shows (memberStateLabel), in
 * the same order. A Stop that is unverified comes first, as in the label and the header, so a row
 * reading Stop unverified never explains an ordinary provider turn on hover.
 */
export function rowStateTitle(agent: TeamAgent): string {
	const unavailable = observationUnavailable(agent);
	if (agent.stopUnverified) return STOP_UNVERIFIED_TITLE;
	if (unavailable) return UNAVAILABLE_NOTE;
	if (nativeCompacting(agent)) return COMPACTION_TITLE;
	// Busy outranks a launch phase in the label, so the tooltip explains Busy, not the phase.
	if (providerWorking(agent)) return PROVIDER_TURN_TITLE;
	if (launchLabel(agent) && agent.launch) return launchTooltip(agent.launch);
	if (providerTurnUnknown(agent)) return PROVIDER_TURN_UNKNOWN_TITLE;
	if (agent.status === 'unknown') return offlineTitle(agent);
	return launchEndedNote(agent);
}

/**
 * Build one roster row. Returned inert - the caller owns selection, focus and pane creation,
 * because those are window state rather than anything about the teammate.
 */
export function memberRow(agent: TeamAgent, selected: string): HTMLButtonElement {
	const button = document.createElement('button');
	button.className = `member ${agent.status}`;
	button.dataset.slug = agent.slug;
	button.dataset.provider = agent.provider;
	if (agent.memberType === 'pm') button.dataset.role = 'pm';
	button.title = [
		providerLimitFact(agent),
		agent.expertise?.trim() ? `Expertise: ${agent.expertise.trim()}` : '',
		agent.domain?.trim() ? `Domain: ${agent.domain.trim()}` : '',
	]
		.filter(Boolean)
		.join('\n\n');
	button.setAttribute('aria-current', String(agent.slug === selected));
	const avatar = document.createElement('span');
	avatar.className = 'avatar';
	avatar.textContent = agent.name.slice(0, 1).toUpperCase();
	if (agent.avatar) {
		const image = document.createElement('img');
		image.alt = '';
		image.src = agent.avatar;
		image.addEventListener(
			'error',
			() => {
				avatar.textContent = agent.name.slice(0, 1).toUpperCase();
			},
			{ once: true },
		);
		avatar.replaceChildren(image);
	}
	const description = document.createElement('span');
	const name = document.createElement('strong');
	name.textContent = agent.name;
	const detail = document.createElement('small');
	detail.className = 'member-state';
	const online = agent.status === 'running' || agent.status === 'elsewhere';
	const unavailable = observationUnavailable(agent);
	const activity = online && !unavailable ? agent.activity : undefined;
	const providerBusy = !unavailable && providerWorking(agent);
	button.classList.toggle(
		'busy',
		activity === 'busy' || providerBusy || (!unavailable && nativeCompacting(agent)),
	);
	button.classList.toggle('needs-user', activity === 'needs-user');
	writeStateLabel(detail, agent);
	// The phase rides on the row as data, the way head-down does, so the dot's ring is styled
	// from it and a probe can read it; the observation that set it lives in the tooltip.
	if (unavailable) button.dataset.observation = 'unavailable';
	else if (!nativeCompacting(agent) && !providerBusy && launchLabel(agent) && agent.launch)
		button.dataset.launchPhase = agent.launch.phase;
	const stateTitle = rowStateTitle(agent);
	if (stateTitle) detail.title = stateTitle;
	const elapsed = document.createElement('small');
	elapsed.className = 'launch-elapsed';
	markElapsed(elapsed, connectingSince(agent, memberStateLabel(agent)));
	description.append(name, detail, elapsed);
	if (agent.provider === 'claude' && agent.claudeConfigDir) {
		const account = document.createElement('small');
		account.className = 'member-account';
		account.textContent = claudeAccountLabel(agent);
		account.title = `Claude configuration directory: ${agent.claudeConfigDir}. The signed-in identity is managed in Claude.`;
		description.append(account);
	}
	const working = document.createElement('small');
	working.className = 'working-on';
	/*
	 * HEAD-DOWN REPLACES THE SELF-WRITTEN LINE rather than sitting beside it. The roster column is
	 * 252px and will not carry two texts legibly, and between the two the goal is the one the
	 * operator agreed to - the teammate's own status stays readable in the tooltip.
	 *
	 * The modifier goes on the row, never on the dot's colour: head-down is something a teammate is
	 * doing, not something it has become, so the dot keeps reporting whether the session is alive.
	 */
	const headDown = agent.headDown;
	const active = headDown?.phase === 'active' ? headDown : undefined;
	const self = unavailable ? UNAVAILABLE_NOTE : statusText(agent.workingOn);
	const row = headDownRow(agent.status, self, headDown);
	working.textContent = row.phase ? row.line : memberWorkingText(agent);
	if (row.phase) button.dataset.headDown = row.phase;
	button.classList.toggle('overdue', row.overdue);
	working.title = [
		active ? `Head-down: ${active.goal}` : '',
		active ? `Done when: ${active.completion}` : '',
		active?.approvedBy ? `Approved by ${active.approvedBy}` : '',
		active?.overdue ? 'Heartbeat overdue - the session has stopped reporting' : '',
		headDown?.phase === 'requested' ? `Head-down requested: ${headDown.goal}` : '',
		active ? `Its own status: ${self}` : self,
		button.title,
	]
		.filter(Boolean)
		.join('\n\n');
	description.append(working);
	const badges = document.createElement('span');
	badges.className = 'member-badges';
	if (activity === 'needs-user') {
		const hand = document.createElement('span');
		hand.textContent = '✋';
		hand.title = 'Needs your attention';
		hand.setAttribute('aria-label', hand.title);
		badges.append(hand);
	}
	if (agent.unreadMail) {
		const mail = document.createElement('span');
		mail.className = 'mail-count';
		mail.textContent = `✉ ${agent.unreadMail}`;
		mail.title = `${agent.unreadMail} unread mail message(s)`;
		mail.setAttribute('aria-label', mail.title);
		badges.append(mail);
	}
	const identity = memberIdentity(avatar, name, badges, agent);
	if (agent.memberType === 'pm') name.after(roleTag());
	const dot = document.createElement('span');
	dot.className = 'dot';
	// Distinguish sessions that ended from teammates never started, and name the phase a session
	// ended in when it never got as far as speaking.
	const launching = unavailable ? undefined : launchLabel(agent);
	dot.title = online
		? !unavailable && nativeCompacting(agent)
			? COMPACTION_TITLE
			: activity === 'busy'
				? 'Busy (self-reported)'
				: providerBusy
					? 'Busy (reported by the provider)'
					: launching
						? `Launching: ${launching}`
						: unavailable
							? 'Running; status unavailable'
							: 'Online'
		: [offlineTitle(agent), launchEndedNote(agent)].filter(Boolean).join(' — ');
	button.append(identity, description, dot);
	return button;
}

/**
 * The PM's role, beside the name rather than among the badges: the badges are things to act on
 * (a raised hand, unread mail), and this is who the member is. Text rather than colour carries it,
 * and the abbreviation expands on hover. The session header spells it out in full (#5734).
 */
function roleTag(): HTMLElement {
	const tag = document.createElement('abbr');
	tag.className = 'role-tag';
	tag.textContent = 'PM';
	tag.title = 'Project manager';
	return tag;
}
