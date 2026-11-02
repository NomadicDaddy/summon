import type { TeamAgent } from '../../src/desktop/types.ts';

import { memberRow } from '../../src/desktop/member-identity.ts';
import { restoreRestFocus, restRosterRow } from '../../src/desktop/rest-roster.ts';

export function checkRestRoster(): number {
	let assertions = 0;
	const assert = (condition: boolean, reason: string) => {
		assertions++;
		if (!condition) throw new Error(reason);
	};
	const agent: TeamAgent = {
		slug: 'resting',
		name: 'Resting teammate',
		cwd: '.',
		provider: 'codex',
		status: 'running',
		activity: 'needs-user',
		unreadMail: 3,
		restConfirmation: 'confirmed-rest',
	};
	const host = document.createElement('div');
	document.body.append(host);
	let selected = 0;
	const stopped: string[] = [];
	const render = () => {
		const member = memberRow(agent, agent.slug);
		member.addEventListener('click', () => selected++);
		host.replaceChildren(
			restRosterRow(agent, member, (slug, confirmation) => {
				stopped.push(`${slug}:${confirmation}`);
			}),
		);
	};
	render();
	const stop = host.querySelector<HTMLButtonElement>('.rest-stop');
	assert(!!stop, 'Confirmed running session has stop control');
	assert(!host.querySelector('button button'), 'Stop remains outside selection button');
	assert(
		host.querySelector('.member-state')?.textContent === 'Needs you',
		'Attention state survives stale rest confirmation',
	);
	assert(
		host.querySelector('.dot')?.getAttribute('aria-hidden') === 'true',
		'Redundant dot hidden to AT',
	);
	assert(
		host.querySelector('.member-badges')?.textContent === '✋✉ 3',
		'Attention badges remain',
	);
	assert(
		stop?.getAttribute('aria-label')?.includes('Stop Session') === true,
		'Stop action accessible',
	);
	stop?.click();
	assert(
		selected === 0 && stopped.join() === 'resting:confirmed-rest',
		'Only exact rest stop invoked',
	);
	stop?.focus();
	render();
	restoreRestFocus(host, agent.slug);
	assert(
		document.activeElement === host.querySelector('.rest-stop'),
		'Stop focus survives snapshot',
	);
	assert(
		host.querySelector('.member')?.getAttribute('aria-current') === 'true',
		'Selection retained',
	);
	agent.activity = 'idle';
	render();
	assert(
		host.querySelector('.member-state')?.textContent === 'Resting',
		'Idle confirmed rest label',
	);
	agent.provider = 'claude';
	agent.ownedSession = true;
	agent.nativeCompacting = true;
	render();
	const compacting = host.querySelector('.member-state');
	assert(
		compacting?.textContent === 'Compacting…' &&
			compacting.getAttribute('aria-label') === 'Compacting…' &&
			compacting.classList.contains('letter-sweep'),
		'Native compaction label and accessible animation survive rest confirmation',
	);
	agent.observationUnavailable = true;
	render();
	assert(
		host.querySelector('.member-state')?.textContent === 'Status unavailable',
		'Unavailable observation is never represented as rest',
	);
	delete agent.observationUnavailable;
	delete agent.nativeCompacting;
	agent.launch = {
		phase: 'startup',
		since: '2026-10-12T19:00:00.000Z',
		evidence: 'mail-readiness',
	};
	render();
	assert(
		host.querySelector('.member-state')?.textContent === 'Summon startup…',
		'Observed launch phase survives rest confirmation',
	);
	delete agent.launch;
	delete agent.restConfirmation;
	render();
	assert(
		!host.querySelector('.rest-stop') &&
			host.querySelector('.member-state')?.textContent === 'Ready',
		'No stale rest display after withdrawal',
	);
	assert(!host.querySelector('.dot')?.hasAttribute('aria-hidden'), 'Online dot restored');
	agent.restConfirmation = 'new-rest';
	agent.status = 'elsewhere';
	render();
	assert(!host.querySelector('.rest-row'), 'Other window does not offer local stop');
	host.remove();
	return assertions;
}
