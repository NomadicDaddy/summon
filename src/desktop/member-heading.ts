import type { MemberFactsSource } from './member-facts.ts';

import { memberFacts } from './member-facts.ts';
import { providerLabels } from './provider-labels.ts';

/** Keep provider and attention badges compact without changing session state or status text. */
export function memberIdentity(
	avatar: HTMLElement,
	name: HTMLElement,
	badges: HTMLElement,
	agent: MemberFactsSource,
): HTMLElement {
	const heading = document.createElement('span');
	heading.className = 'member-heading';
	name.before(heading);
	heading.append(name, badges);
	const identity = document.createElement('span');
	identity.className = 'member-identity';
	const pill = document.createElement('small');
	pill.className = 'member-provider';
	pill.textContent = providerLabels[agent.provider].short;
	// The session header's facts, one per line (Phillip #7999).
	pill.title = memberFacts(agent).join('\n');
	pill.setAttribute('aria-label', pill.title);
	identity.append(avatar, pill);
	return identity;
}
