import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

import { communicationState } from './communication-state.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';
import { messageWasPublished, sendMessage } from './mailbox.ts';
import { responseStatus } from './response-watchdog-store.ts';
import { listAgentSlugs, loadAgent, slugFor } from './store.ts';

const publication = z.object({ text: z.string().min(1).max(2048) }).strict();
const relaySchema = z
	.object({
		version: z.literal(1),
		owner: z.string().min(1).max(64),
		nonce: z.string().regex(/^[a-z0-9-]+$/i),
		episode: z.uuid(),
		alert: publication,
		recipients: z
			.array(
				z
					.object({
						name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
						alertId: z.uuid(),
						resolutionId: z.uuid(),
						sent: z.boolean(),
						cleared: z.boolean(),
					})
					.strict(),
			)
			.max(256),
		resolution: publication.nullable(),
	})
	.strict();
type Relay = z.infer<typeof relaySchema>;

const labels = {
	'awaiting-read': 'Delivered, awaiting read confirmation',
	blocked: 'Work waiting, delivery blocked',
	uncertain: 'Input may have begun, awaiting read confirmation',
	inventory: 'Delivery inventory unavailable',
};

async function isPm(name: string): Promise<boolean> {
	try {
		const record = await loadAgent(name);
		return record?.memberType === 'pm' && slugFor(record.name) === name;
	} catch {
		// An invalid registration is never a PM recipient and does not hide healthy PMs.
		return false;
	}
}

/** Owner-only metadata relay; it never reads the monitored message bodies or writes provider input. */
export async function relayResponseWatchdog(name: string, nonce: string): Promise<void> {
	ownMailbox(name);
	// No self-escalation: unread PM alerts must not recursively generate more PM alerts.
	const ownerIsPm = (await loadAgent(name))?.memberType === 'pm';
	const path = join(runtimePath(name), 'response-watchdog-relay.json');
	await locked(`${path}.lock`, async () => {
		const current = await responseStatus(name, nonce);
		if (!current || current.suspended) return;
		const raw = await optionalText(path);
		if (raw && Buffer.byteLength(raw) > 65536) throw new Error('Response relay is oversized.');
		let retained: Relay | null = raw
			? relaySchema.nullable().parse(JSON.parse(raw) as unknown)
			: null;
		if (retained && retained.owner !== name) throw new Error('Response relay owner mismatch.');
		const save = async () =>
			atomicWrite(path, JSON.stringify(relaySchema.nullable().parse(retained)));
		const send = async (item: z.infer<typeof publication>, recipient: string, id: string) => {
			if ((await communicationState()).paused) return false;
			await sendMessage(name, recipient, item.text, { id, replaySafe: true });
			return true;
		};
		if (
			retained &&
			(retained.nonce !== nonce ||
				retained.episode !== current.id ||
				current.phase === 'clear')
		) {
			// A changed observation identity alone is not proof that its old work retired.
			if (!retained.resolution) {
				const reason =
					retained.nonce !== nonce
						? 'the monitored launch was replaced; this is not read confirmation'
						: current.retiredEpisodeId === retained.episode
							? 'the monitored episode has resolved; its outstanding targets or unavailable inventory no longer require attention'
							: 'observation continuity ended or reset; prior work may still require attention. This is not read confirmation';
				retained.resolution = {
					text: `Delivery watchdog update for ${name}. Episode ${retained.episode}: ${reason}. This is not task completion. No input was retried and no lifecycle action is authorized.`,
				};
				await save();
			}
			for (const recipient of retained.recipients) {
				if (!(await isPm(recipient.name))) continue;
				if (!recipient.sent) {
					// Distinguish publish-then-crash from an alert blocked for its entire lifetime.
					if (
						!(await messageWasPublished(
							name,
							recipient.name,
							retained.alert.text,
							recipient.alertId,
						))
					)
						continue;
					recipient.sent = true;
					await save();
				}
				if (!recipient.cleared) {
					if (!(await send(retained.resolution, recipient.name, recipient.resolutionId)))
						return;
					recipient.cleared = true;
					await save();
				}
			}
			retained = null;
			await save();
		}
		if (!retained && current.phase === 'attention' && !ownerIsPm) {
			const recipients = [];
			for (const slug of await listAgentSlugs()) {
				if (slug !== name && (await isPm(slug)))
					recipients.push({
						name: slug,
						alertId: randomUUID(),
						resolutionId: randomUUID(),
						sent: false,
						cleared: false,
					});
			}
			if (!recipients.length) return;
			const oldest = current.expectations.reduce((a, b) =>
				a.progressAt < b.progressAt ? a : b,
			);
			const minutes = Math.floor(Math.max(0, current.updatedAt - oldest.progressAt) / 60000);
			retained = {
				version: 1,
				owner: name,
				nonce,
				episode: current.id,
				recipients,
				resolution: null,
				alert: {
					text: `Delivery watchdog alert for ${name}, observed ${new Date(current.updatedAt).toISOString()}: ${labels[oldest.condition]} ${minutes} min. Episode ${current.id}. A long working turn can cause this; it does not prove a crash or lost input. Inspect or ask the operator. No input retry, approval release or stop/restart is authorized. One alert is sent per episode; an update follows when it ends.`,
				},
			};
			await save();
		}
		if (retained) {
			if (current.phase !== 'attention') return;
			for (const recipient of retained.recipients) {
				if (recipient.sent || !(await isPm(recipient.name))) continue;
				if (!(await send(retained.alert, recipient.name, recipient.alertId))) return;
				recipient.sent = true;
				await save();
			}
		}
	});
}
