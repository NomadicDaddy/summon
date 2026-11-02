import { randomUUID } from 'node:crypto';

import type { CheckpointInput } from './checkpoint-package-pages.ts';
import type { SkipPlan } from './checkpoint-skip-model.ts';

import { checkpointConfig, telegramIdentity } from './checkpoint-package-capture.ts';
import { checkpointHash, parseCheckpointState } from './checkpoint-package-model.ts';
import { checkpointStatePath, loadCheckpointPackage } from './checkpoint-package-store.ts';
import { skippedThrough } from './checkpoint-skip-model.ts';
import { requireSettledCatchUp } from './checkpoint-skip-progress.ts';
import { saveSkipPlan, skipView } from './checkpoint-skip-store.ts';
import { currentRoomInputs, currentTelegramInputs } from './current-request-selection.ts';
import { cachedLocalEvents } from './local-room.ts';
import { locked, optionalText } from './mail-files.ts';
import { localCursorPath, roomCursor } from './room-cursor.ts';
import { roomCursorPath } from './telegram-live.ts';
import { refreshTelegramForLocal, type TelegramUnavailable } from './telegram-local-refresh.ts';
import { roomEvents } from './telegram-room.ts';

function retainedReferences(inputs: CheckpointInput[]): SkipPlan['references'] {
	const references = new Map<string, SkipPlan['references'][number]>();
	for (const input of inputs) {
		if (input.source !== 'room' && input.source !== 'telegram') continue;
		const key = `${input.source}:${input.id}`;
		const existing = references.get(key);
		const parents: SkipPlan['references'][number]['parents'] = [];
		if (input.source === 'room' && input.value.replyTo !== null)
			parents.push({ source: 'room', id: String(input.value.replyTo) });
		if (input.source === 'telegram') {
			if (input.value.localReplyTo)
				parents.push({ source: 'room', id: String(input.value.localReplyTo) });
			if (input.value.replyTo !== null) {
				const messageId = input.value.replyTo;
				const ancestor = inputs.find(
					(candidate) =>
						candidate.source === 'telegram' && candidate.value.messageId === messageId,
				);
				if (!ancestor) throw new Error('Retained Telegram reply context is unavailable.');
				parents.push({ source: 'telegram', id: ancestor.id });
			}
		}
		references.set(key, {
			source: input.source,
			id: input.id,
			addressed: input.forMe || existing?.addressed === true,
			body: JSON.stringify(input.value),
			snippet: Array.from(input.value.text).slice(0, 120).join(''),
			parents,
		});
	}
	return [...references.values()];
}

/** Preparing a plan never advances a cursor or acknowledges an embedded mail body. */
export async function prepareCatchUp(name: string, keepPages: number) {
	if (!Number.isSafeInteger(keepPages) || keepPages < 1 || keepPages > 3)
		throw new Error('Keep pages must be an integer from 1 through 3.');
	return locked(`${checkpointStatePath(name)}.lock`, async () => {
		await requireSettledCatchUp(name);
		const config = await checkpointConfig(true);
		// An incomplete refresh no longer refuses: the plan holds the Telegram cursor and skips
		// nothing from it, so it claims no remote coverage it could not refresh.
		let held: TelegramUnavailable | undefined;
		if (config)
			await refreshTelegramForLocal(config, false, (_reason, kind) => {
				held = kind;
			});
		const state = parseCheckpointState(await optionalText(checkpointStatePath(name)));
		await loadCheckpointPackage(name, state);
		const history = await cachedLocalEvents();
		const from = roomCursor((await optionalText(localCursorPath(name))) ?? '0');
		if (from > history.length)
			throw new Error('Room cursor exceeds history. Nothing was skipped.');
		const room = skippedThrough(history, from, keepPages, (event) => event.id);
		const telegram = config ? await roomEvents(config) : [];
		if (
			telegram.some((event, index) => event.sequence !== index + 1) ||
			new Set(telegram.map((event) => event.messageId)).size !== telegram.length
		)
			throw new Error('Telegram history positions are inconsistent. Nothing was skipped.');
		const after = config
			? roomCursor((await optionalText(roomCursorPath(config, name))) ?? '0')
			: 0;
		if (after > (telegram.at(-1)?.sequence ?? 0))
			throw new Error('Telegram cursor exceeds history. Nothing was skipped.');
		const remote = held
			? { from: after, through: after, count: 0 }
			: skippedThrough(telegram, after, keepPages, (event) => event.sequence);
		const plan: SkipPlan = {
			version: 1,
			owner: name,
			id: randomUUID(),
			createdAt: new Date().toISOString(),
			keepPages,
			state,
			room,
			roomHash: checkpointHash(history.filter((event) => event.id <= room.through)),
			...(config
				? {
						telegram: { ...remote, key: telegramIdentity(config) },
						telegramHash: checkpointHash(
							telegram.filter((event) => event.sequence <= remote.through),
						),
						...(held ? { telegramHeld: held } : {}),
					}
				: {}),
			references: retainedReferences([
				...currentRoomInputs(
					name,
					history.filter((event) => event.id <= room.through),
					from,
				),
				...currentTelegramInputs(
					name,
					telegram.filter((event) => event.sequence <= remote.through),
					after,
					history,
				),
			]),
		};
		await saveSkipPlan(name, plan);
		return skipView(name, plan);
	});
}
