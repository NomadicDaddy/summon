import type { TeamAgent } from './types.ts';

import { recordedSettings } from './model-settings.ts';
import { responseFact } from './response-watchdog-facts.ts';

/** The fields of a teammate that the session header, the provider tooltip and a copy describe. */
export type MemberFactsSource = Pick<
	TeamAgent,
	| 'claudeConfigDir'
	| 'claudeConfigInherited'
	| 'cwd'
	| 'modelInfo'
	| 'provider'
	| 'responseWatchdog'
	| 'responseWatchdogError'
>;

/**
 * `Account: <directory>`, or `Account: Default` for the inherited account; empty for others.
 * Directory labels distinguish selections; they do not claim a verified login identity.
 */
export function claudeAccountLabel(agent: Omit<MemberFactsSource, 'cwd' | 'modelInfo'>): string {
	if (agent.provider !== 'claude' || !agent.claudeConfigDir) return '';
	const directory = agent.claudeConfigDir.split(/[\\/]/).filter(Boolean).at(-1);
	return `Account: ${agent.claudeConfigInherited ? 'Default' : (directory ?? agent.claudeConfigDir)}`;
}

/**
 * What the session header, the provider mark's tooltip and a Shift+click copy all say about a
 * teammate, in one order: provider, model, reasoning, context capacity with its exact tokens,
 * the Claude account, then the working directory (Phillip #7999, so all three match). Values
 * carry no field labels; the account keeps its own because "Default" alone names nothing. The
 * directory is last because it is the one part the header's ellipsis may cut.
 */
export function memberFacts(agent: MemberFactsSource): string[] {
	const { capacity, model, reasoning } = recordedSettings(agent.modelInfo);
	return [
		agent.provider,
		model,
		reasoning,
		capacity,
		claudeAccountLabel(agent),
		agent.responseWatchdogError ?? responseFact(agent.responseWatchdog),
		agent.cwd,
	].filter(Boolean);
}
