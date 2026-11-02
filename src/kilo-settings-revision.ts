import { createHash } from 'node:crypto';

import type { AgentRecord } from './store.ts';

import { kiloSettingsStale } from './kilo-settings-stale.ts';
import { applyKiloVariant } from './kilo-variant.ts';

interface Settings {
	model?: string;
	variant?: string;
	lmStudioUrl?: string;
}

/** Session/model observations are not edits to the model settings the form loaded. */
export function kiloSettingsRevision(settings: Settings): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				settings.model ?? '',
				settings.variant ?? '',
				settings.lmStudioUrl ?? '',
			]),
		)
		.digest('hex');
}

/** Compare the current record under its write lock, before changing any registration field. */
export function assertKiloSettingsCurrent(
	profile: AgentRecord,
	input: { provider: string; kiloSettingsRevision?: string | null },
	creating: boolean,
): void {
	if (creating || (profile.provider !== 'kilo' && input.provider !== 'kilo')) return;
	const revision = input.kiloSettingsRevision;
	if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))
		throw new Error('Invalid Kilo settings revision; reload this profile.');
	if (revision !== kiloSettingsRevision(profile)) throw new Error(kiloSettingsStale);
}

/** Preserve the existing contract: absent variant keeps it; an empty variant clears it. */
export function applyModelSettings(profile: AgentRecord, input: Settings): void {
	if (input.model) profile.model = input.model;
	else delete profile.model;
	applyKiloVariant(profile, input.variant);
	if (input.lmStudioUrl) profile.lmStudioUrl = input.lmStudioUrl;
	else delete profile.lmStudioUrl;
}
