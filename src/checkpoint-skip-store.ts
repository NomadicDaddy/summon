import { join } from 'node:path';

import { checkpointHash, checkpointId } from './checkpoint-package-model.ts';
import {
	skipAppliedSchema,
	type SkipPlan,
	skipPlanEnvelopeSchema,
	validateSkipPlan,
} from './checkpoint-skip-model.ts';
import { skipProgressPath } from './checkpoint-skip-progress.ts';
import { CHECKPOINT_CATCH_UP_HOLD } from './checkpoint-work.ts';
import { atomicWrite, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { assertReadWindow, boundedBytes } from './mail-read.ts';
import { runtimePath } from './mail-session.ts';

export function skipPath(name: string, id?: string): string {
	ownMailbox(name);
	return id === undefined
		? skipProgressPath(name)
		: join(runtimePath(name), 'checkpoint-skips', `${checkpointId.parse(id)}.json`);
}

export async function loadSkipPlan(name: string, id: string): Promise<SkipPlan> {
	const raw = await optionalText(skipPath(name, id));
	if (raw === undefined)
		throw new Error('Unknown own-session catch-up plan. Nothing was skipped.');
	const envelope = skipPlanEnvelopeSchema.parse(JSON.parse(raw) as unknown);
	if (checkpointHash(envelope.plan) !== envelope.sha256)
		throw new Error('Catch-up plan integrity check failed. Nothing further was skipped.');
	return validateSkipPlan(envelope.plan, name);
}

export const skipAppliedPath = (name: string, id: string): string =>
	`${skipPath(name, id)}.applied`;

export async function appliedSkip(name: string, plan: SkipPlan) {
	const raw = await optionalText(skipAppliedPath(name, plan.id));
	if (raw === undefined) return undefined;
	const result = skipAppliedSchema.parse(JSON.parse(raw) as unknown);
	if (result.owner !== name || result.id !== plan.id || result.sha256 !== checkpointHash(plan))
		throw new Error('Invalid catch-up completion record. Nothing further was skipped.');
	return result;
}

export async function saveSkipPlan(name: string, plan: SkipPlan): Promise<void> {
	validateSkipPlan(plan, name);
	await atomicWrite(
		skipPath(name, plan.id),
		JSON.stringify({ version: 1, sha256: checkpointHash(plan), plan }),
	);
}

export async function skipView(name: string, plan: SkipPlan, start = 0) {
	if (!Number.isSafeInteger(start) || start < 0)
		throw new Error('Invalid catch-up index offset.');
	const addressed = plan.references.filter((reference) => reference.addressed);
	if (start > addressed.length) throw new Error('Catch-up index offset exceeds its inventory.');
	const entries: { source: string; id: string; snippet: string; read: string }[] = [];
	let bytes = 0;
	for (const reference of addressed.slice(start, start + 100)) {
		const entry = {
			source: reference.source,
			id: reference.id,
			snippet: reference.snippet,
			read: `summon --checkpoint catch-up show ${plan.id} ${reference.source} ${reference.id}`,
		};
		const size = Buffer.byteLength(JSON.stringify(entry));
		if (bytes + size > 23_000) break;
		entries.push(entry);
		bytes += size;
	}
	const end = start + entries.length;
	const applied = (await appliedSkip(name, plan)) !== undefined;
	return {
		catchUp: {
			id: plan.id,
			owner: plan.owner,
			createdAt: plan.createdAt,
			sha256: checkpointHash(plan),
			applied,
			rolloutHold: CHECKPOINT_CATCH_UP_HOLD,
			keepPages: plan.keepPages,
			tailBudget:
				'About 26,000 serialized UTF-8 bytes per kept page, per source; complete events.',
			skipped: { room: plan.room, ...(plan.telegram ? { telegram: plan.telegram } : {}) },
			...(plan.telegramHeld
				? { telegramCoverage: { held: true, reason: plan.telegramHeld } }
				: {}),
			addressedCount: addressed.length,
			entries,
			next: end < addressed.length ? String(end) : null,
			list: `summon --checkpoint catch-up list ${plan.id}`,
			apply: `summon --checkpoint catch-up apply ${plan.id}`,
			instruction:
				(applied
					? 'Applied: the recorded ranges were skipped, not read. '
					: 'Preview/index only; review addressed references before applying. ') +
				(plan.telegramHeld
					? 'Telegram was not refreshed, so its cursor is held: nothing from Telegram is skipped and no remote coverage is claimed. Recorded Telegram events still arrive through normal checkpoint receipts. '
					: '') +
				'Full bodies and their reply context are retained in this own-session plan; show them on demand. Skipping never completes work or grants approval. Direct mail and holds are untouched. New arrivals and the recent tail still use normal checkpoint receipts.',
		},
	};
}

export function skipBody(plan: SkipPlan, source: string, id: string, offset = 0) {
	assertReadWindow(offset, 8192);
	const item = plan.references.find(
		(reference) => reference.source === source && reference.id === id,
	);
	if (!item) throw new Error('Reference is not retained in this catch-up plan.');
	const bytes = Buffer.from(item.body);
	if (offset > bytes.length) throw new Error('Catch-up body offset exceeds its size.');
	const chunk = boundedBytes(bytes.subarray(offset), 8192);
	return {
		readOnly: true,
		source,
		id,
		text: chunk.text,
		end: offset + chunk.count,
		size: bytes.length,
		parents: item.parents.map((parent) => ({
			...parent,
			read: `summon --checkpoint catch-up show ${plan.id} ${parent.source} ${parent.id}`,
		})),
		instruction:
			'Retained original JSON; follow parent read commands for complete reply context. No cursor, mail read coverage, handling or approval changes.',
	};
}
