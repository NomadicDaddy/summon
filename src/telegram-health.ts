import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import type { TelegramConfig, TelegramRequestError } from './telegram-api.ts';

import { communicationState } from './communication-state.ts';
import { appendLocalEvent } from './local-room.ts';
import { atomicWrite, optionalText } from './mail-files.ts';
import { telegramRoot } from './telegram-room.ts';

const episodeSchema = z
	.object({
		id: z.uuid(),
		reason: z.string().max(512),
		announced: z.boolean(),
	})
	.strict()
	.nullable();

/**
 * How long a transient failure must persist before it is announced. Most Telegram blips clear on the
 * next refresh, a second or two later, and announcing each one posted a failed/recovered pair.
 */
export const TRANSIENT_FAILURE_GRACE_MS = 60_000;

/**
 * Called only while holding the bot's poll lock. Never sends through Telegram or clears halt.
 *
 * An unannounced episode's start is health.json's modification time, since the file is written when
 * the episode opens and not again until it is announced or cleared. Keeping the stored shape
 * unchanged matters: older Summon builds parse this file strictly and share it.
 */
export async function recordTelegramHealth(
	config: TelegramConfig,
	failure?: Pick<TelegramRequestError, 'reason' | 'transient'>,
): Promise<void> {
	const path = join(telegramRoot(config), 'health.json');
	const raw = await optionalText(path);
	const reason = failure?.reason;
	let episode: z.infer<typeof episodeSchema> = null;
	if (raw !== undefined) {
		try {
			episode = episodeSchema.parse(JSON.parse(raw) as unknown);
		} catch {
			throw new Error('Invalid Telegram health state.');
		}
	}
	if (reason && !episode) {
		episode = { id: randomUUID(), reason, announced: false };
		await atomicWrite(path, JSON.stringify(episode));
	}
	if (!episode || (await communicationState()).paused) return;
	if (reason && episode.announced) return;
	// The file's time can read slightly ahead of Date.now(), so a start up to one grace period ahead is
	// treated as just opened. One further ahead (a clock moved back, a copied file) counts as past the
	// grace, so a bad timestamp can delay an alert, never suppress it.
	const age = Date.now() - (await stat(path)).mtimeMs;
	if (failure?.transient && Math.abs(age) < TRANSIENT_FAILURE_GRACE_MS) return;
	if (reason || episode.announced) {
		await appendLocalEvent({
			sender: { kind: 'cli', id: 'telegram-health' },
			text: reason
				? `Telegram refresh failed: ${reason} Remote halt/proceed messages may not reach Summon. Local work uses the recorded communication state; remote halt/proceed updates may be pending. Check Telegram access and configuration; this notice repeats only after a successful refresh and a new failure.`
				: 'Telegram refresh recovered. Pending remote signals are being processed normally again. Recovery alone does not change the recorded communication state.',
			replyTo: null,
			source: `telegram-health:${episode.id}:${reason ? 'failed' : 'recovered'}`,
		});
	}
	await atomicWrite(path, JSON.stringify(reason ? { ...episode, announced: true } : null));
}
