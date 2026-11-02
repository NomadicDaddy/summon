import type { Provider } from './store.ts';

import { providerTurn } from './provider-turn.ts';
import { providers } from './store.ts';

/** A refusal before stopping is distinct from an uncertain physical stop failure. */
export class RestStopRefusedError extends Error {}

export async function assertRestStopTurn(
	provider: Provider,
	slug: string,
	nonce: string,
): Promise<void> {
	if (!providers.includes(provider))
		throw new RestStopRefusedError(
			`${slug}: owned provider is unavailable; refresh the roster.`,
		);
	const turn = await providerTurn(provider, slug, nonce);
	if (turn !== undefined)
		throw new RestStopRefusedError(
			`${slug}: rest stop refused; ${provider} turn is ${turn === 'busy' ? 'busy' : 'unknown or unreadable'}.`,
		);
	// Other providers' missing records retain the explicit-rest/activity checks. Codex
	// permits this path only after the bound daemon thread explicitly reports loaded idle.
}
