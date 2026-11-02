import type { TeamAgent } from './types.ts';

export const labels = {
	offline: 'Not running',
	running: 'Ready',
	elsewhere: 'In another window',
	unknown: 'Lock held, not verified',
	exited: 'Session ended',
	stopped: 'Stopped by operator',
	hibernated: 'Hibernated',
};
/** A held lock whose process could not be verified: why, and when that was read. */
export const unverifiedTitle = (presence: { reason: string; observedAt: string } | undefined) =>
	`Lock held, not verified${presence ? `: ${presence.reason}. Checked ${new Date(presence.observedAt).toLocaleTimeString()}` : ''}`;
export const offlineTitle = (agent: {
	exitCode?: number;
	status: string;
	presence?: { reason: string; observedAt: string };
}): string =>
	agent.status === 'unknown'
		? unverifiedTitle(agent.presence)
		: agent.status === 'hibernated'
			? 'Hibernated by the operator; automatic wakes are blocked'
			: agent.status === 'stopped'
				? 'Stopped by the operator'
				: agent.status === 'exited'
					? `Session ended${agent.exitCode === undefined ? '' : ` (code ${String(agent.exitCode)})`} — nobody stopped it`
					: 'Offline';

export function setupHibernationControls(onError: (error: unknown) => void) {
	const button = document.getElementById('hibernate') as HTMLButtonElement;
	let selected: TeamAgent | undefined;
	button.addEventListener('click', () => {
		if (!selected) return;
		void window.team.hibernate(selected.slug, selected.status !== 'hibernated').catch(onError);
	});
	return (agent: TeamAgent | undefined): void => {
		selected = agent;
		button.hidden = !agent;
		const resuming = agent?.status === 'hibernated';
		button.textContent = resuming ? 'Unhibernate' : 'Hibernate';
		button.classList.toggle('primary', resuming);
		button.title = resuming
			? 'Allow delivery and resume this teammate'
			: 'Block delivery and automatic wakes; ask the session to wrap up without terminating it';
	};
}
