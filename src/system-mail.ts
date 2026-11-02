import { z } from 'zod';

import { readActivity } from './agent-activity.ts';
import { readRest } from './rest.ts';

const nonce = z.string().regex(/^[a-zA-Z0-9-]{1,128}$/);
export const systemMailSchema = z.discriminatedUnion('purpose', [
	z.object({ purpose: z.literal('rest-nudge'), nonce, idleSince: z.iso.datetime() }).strict(),
	z
		.object({
			purpose: z.literal('rest-ended'),
			nonce,
			confirmation: z.uuid(),
			previousActivityNonce: nonce.nullable(),
		})
		.strict(),
]);

export type SystemMail = z.infer<typeof systemMailSchema>;
export type SystemMailStatus = 'current' | 'obsolete' | 'unverifiable';

export function parseSystemMail(value: unknown): SystemMail {
	const result = systemMailSchema.safeParse(value);
	if (!result.success) throw new Error('Invalid generated notice metadata.');
	return result.data;
}

export function decodeSystemMail(text: string): SystemMail {
	try {
		return parseSystemMail(JSON.parse(text) as unknown);
	} catch {
		throw new Error('Invalid generated notice metadata.');
	}
}

/** Explicit producer provenance only: never infer a notice from an old message's wording. */
export async function systemMailStatus(
	name: string,
	notice: SystemMail,
): Promise<SystemMailStatus> {
	// Cover readers can inspect a permitted inbox, but not its owner's private runtime.
	if (process.env.SUMMON_AGENT && process.env.SUMMON_AGENT !== name) return 'unverifiable';
	const activity = await readActivity(name);
	if (!activity) return 'unverifiable';
	if (activity.nonce !== notice.nonce) {
		// Team startup can publish a notice before its child replaces retained activity.
		// Only a nonce beyond both the owned launch and its retained predecessor proves
		// supersession. A nudge instead records an already observed activity episode.
		// A null predecessor records observed absence, not an unknown earlier nonce.
		if (notice.purpose === 'rest-ended' && activity.nonce === notice.previousActivityNonce)
			return 'unverifiable';
		return 'obsolete';
	}
	// Becoming busy is often the first step in handling this reminder, not supersession.
	if (notice.purpose === 'rest-nudge') return 'current';
	const rest = await readRest(name);
	if (!rest) return 'unverifiable';
	return rest.id === notice.confirmation &&
		['wake-requested', 'waking', 'awake', 'uncertain'].includes(rest.mode)
		? 'current'
		: 'obsolete';
}
