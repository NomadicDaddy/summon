import type { RuntimePrerequisite, RuntimePrerequisiteStatus } from '../runtime-prerequisites.ts';
import type { CliStatus } from './cli-status.ts';

/*
 * The two one-line readings of the CLI check: the line beside the CLI setup heading, and the
 * first-run line in the empty window. Both are sentences about what the check found, so they live
 * together and share how product names are gathered; provider-setup-view.ts draws them.
 */

/**
 * The one-line answer beside the section's heading. It names what is missing rather than counting
 * (card 32f030f9: "Grok Build not found", not "3 of 4"), and never implies sign-in was checked.
 */
export function setupSummary(statuses: CliStatus[], names: Map<string, string>): string {
	const named = namesBy(statuses, names);
	const total = String(statuses.length);
	const missing = named('missing');
	const unchecked = named('unavailable');
	if (!named('available') && !unchecked)
		return `None of the ${total} supported CLIs found yet. Sign-in is not checked.`;
	if (!missing && !unchecked) return `All ${total} supported CLIs found. Sign-in is not checked.`;
	return `${missing ? `Not found: ${missing}. ` : ''}${
		unchecked ? `Could not be checked: ${unchecked}. ` : ''
	}Sign-in is not checked.`;
}

/** The product names of the CLIs that returned one check result, ready for a sentence. */
const namesBy =
	(statuses: CliStatus[], names: Map<string, string>) =>
	(status: CliStatus['status']): string =>
		statuses
			.filter((entry) => entry.status === status)
			.map((entry) => names.get(entry.provider) ?? entry.provider)
			.join(', ');

/**
 * First-run wording for the empty window. Finding nothing is where every new installation starts,
 * so it is written as the first step rather than as a fault.
 */
export function firstRunSummary(statuses: CliStatus[], names: Map<string, string>): string {
	const named = namesBy(statuses, names);
	const found = named('available');
	const missing = named('missing');
	const unchecked = named('unavailable');
	// Two different empty answers. Nothing on PATH is a fresh machine; something on PATH that would
	// not report its version is installed and unwell, and calling that "not installed" would send
	// its owner to an install guide for a thing they already have.
	if (!found && unchecked)
		return `No supported CLI answered its version check. Could not be checked: ${unchecked}. CLI setup has the details for each.`;
	if (!found)
		return 'No supported CLI was found here yet, which is where every new setup starts. CLI setup shows how to install one and what account each needs.';
	return `Found here: ${found}.${missing ? ` Not found: ${missing}.` : ''}${
		unchecked ? ` Could not be checked: ${unchecked}.` : ''
	} Sign-in is not checked.`;
}

/**
 * Missing results stay unchecked; a found provider cannot stand in for its required tools. Each problem
 * names its official installation guide, since this line is the only runtime guidance in the window.
 */
export function prerequisiteSummary(
	requirements: RuntimePrerequisite[],
	statuses: RuntimePrerequisiteStatus[],
): string {
	if (!requirements.length) return 'Runtime prerequisites were not checked.';
	const problems = requirements.flatMap((requirement) => {
		const result = statuses.find((entry) => entry.id === requirement.id);
		if (result?.status === 'available') return [];
		const state = result
			? { missing: 'not found', outdated: 'update needed', unavailable: 'check failed' }[
					result.status
				]
			: 'not checked';
		return [
			`${requirement.name} ${requirement.minimumVersion}+ (${state}; official guide ${requirement.installUrl})`,
		];
	});
	return problems.length
		? `Required tools: ${problems.join('; ')}. Install them separately, then reopen Summon and refresh.`
		: 'Required runtime versions found.';
}
