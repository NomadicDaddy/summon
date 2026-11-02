import type { TeamAgent } from './types.ts';

import { pairingCoverage, providerExposure } from '../pairing-coverage.ts';

/**
 * The cover facts that exist only across the whole roster, rendered above it.
 *
 * Showing each row's coverer would be display: seven edges, with the reader doing the in-degree
 * walk in their head. The facts worth the space are the CONCLUSIONS - who has nobody, who is
 * carrying several, and who a provider outage would strand - because none of them is visible from
 * any single record and nothing else computes them. A field that exists and says nothing is the
 * failure this module was written to avoid.
 */
function line(className: string, label: string, names: readonly string[]): HTMLElement {
	const row = document.createElement('p');
	row.className = className;
	const strong = document.createElement('strong');
	strong.textContent = label;
	row.append(strong, document.createTextNode(` ${names.join(', ')}`));
	return row;
}

/**
 * Renders the summary into `#roster-coverage` and returns the updater the roster calls.
 *
 * Only names that claim a domain are in scope, which is the same rule the CLI applies: a record
 * with no domain claims nothing and so has nothing to cover. That is why an apprentice with an
 * empty domain is absent here rather than counted as an eighth gap.
 */
export function setupRosterCoverage(): (agents: readonly TeamAgent[]) => void {
	const root = document.getElementById('roster-coverage');
	if (root === null) return () => undefined;
	return (agents) => {
		const claiming = agents.filter((agent) => (agent.domain ?? '').trim() !== '');
		const { overSubscribed, uncovered } = pairingCoverage(
			claiming.map((agent) => ({ name: agent.name, coveredBy: agent.coveredBy ?? '' })),
		);
		const rows: HTMLElement[] = [];
		if (claiming.length === 0) {
			root.replaceChildren();
			return;
		}
		const covered = claiming.length - uncovered.length;
		const heading = document.createElement('p');
		heading.className = 'coverage-heading';
		// "Recorded" is load-bearing. This counts assignments, not the ability to answer one: a name
		// can hold cover for a domain it cannot currently reach - hibernating, or on a provider whose
		// sessions will not start - and nothing in the graph says so. A bare "Cover: 6 of 7" reads as
		// reassurance the data cannot support, which is the failure this whole block exists to avoid,
		// one layer up. Liveness is not derivable from what the snapshot carries, so it is not
		// claimed rather than guessed at.
		heading.textContent = `Cover recorded: ${String(covered)} of ${String(claiming.length)} domains`;
		rows.push(heading);
		if (uncovered.length > 0) rows.push(line('coverage-gap', 'Uncovered:', uncovered));
		if (overSubscribed.length > 0)
			rows.push(line('coverage-load', 'Covering several:', overSubscribed));
		// Only the worst outage, not one row per provider: while the cross-provider rule holds every
		// row is the uncovered set regrouped, so listing them all restates the line above it four
		// times. The shape is the fact - which single provider concentration costs the most.
		//
		// "If <provider> is out" is load-bearing rather than padding. Only some of the uncovered names
		// appear here - the ones that run the failed provider - and without the conditional a reader
		// asks why Auden is uncovered and absent. Raised by Jimmy in #1512 after he nearly filed it as
		// a defect; my earlier wording had dropped the condition and made the subset look arbitrary.
		const [worst] = providerExposure(
			claiming.map((agent) => ({
				name: agent.name,
				provider: agent.provider,
				coveredBy: agent.coveredBy ?? '',
			})),
		);
		if (worst && worst.unattended.length > 1)
			rows.push(
				line(
					'coverage-provider',
					`Worst case - if ${worst.provider} is out, these have nobody:`,
					worst.unattended,
				),
			);
		// Never expected: a domain with a coverer that the same outage also takes down. saveProfile
		// refuses that pairing, so this can only come from a record written around it.
		if (worst && worst.despiteCover.length > 0)
			rows.push(line('coverage-gap', 'Cover on the failed provider:', worst.despiteCover));
		root.replaceChildren(...rows);
	};
}
