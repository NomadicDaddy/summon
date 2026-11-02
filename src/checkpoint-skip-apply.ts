import { join } from 'node:path';

import type { SkipPlan } from './checkpoint-skip-model.ts';

import { checkpointConfig, telegramIdentity } from './checkpoint-package-capture.ts';
import { checkpointHash, parseCheckpointState } from './checkpoint-package-model.ts';
import { checkpointStatePath, saveCheckpointState } from './checkpoint-package-store.ts';
import { skipProgress, type SkipProgress } from './checkpoint-skip-progress.ts';
import {
	appliedSkip,
	loadSkipPlan,
	skipAppliedPath,
	skipPath,
	skipView,
} from './checkpoint-skip-store.ts';
import { ackLocalRoom } from './local-room-access.ts';
import { cachedLocalEvents } from './local-room.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { runtimePath } from './mail-session.ts';
import { localCursorPath, roomCursor } from './room-cursor.ts';
import { roomCursorPath } from './telegram-live.ts';
import { roomEvents } from './telegram-room.ts';
import { ackRoom } from './telegram.ts';

function supersededState(plan: SkipPlan) {
	const state = structuredClone(plan.state);
	if (state.current) state.supersededPackage = state.current.id;
	delete state.current;
	delete state.lastAck;
	delete state.emptyReceipt;
	return state;
}

/** A durable intent makes interruption visible until this explicit operation is resumed. */
export async function applyCatchUp(name: string, id: string) {
	return locked(`${checkpointStatePath(name)}.lock`, () =>
		locked(join(runtimePath(name), 'rest.json.lock'), async () => {
			const plan = await loadSkipPlan(name, id);
			const progress = await skipProgress(name);
			if (progress?.phase === 'applying' && progress.id !== id)
				throw new Error(
					`Catch-up ${progress.id} must be recovered before another operation.`,
				);
			const digest = checkpointHash(plan);
			if (progress?.id === id && progress.sha256 !== digest)
				throw new Error('Catch-up plan changed. No further cursor changes were made.');
			if (await appliedSkip(name, plan)) {
				if (progress?.id === id && progress.phase === 'applying')
					await atomicWrite(
						skipPath(name),
						JSON.stringify({ ...progress, phase: 'applied' }),
					);
				return skipView(name, plan);
			}
			const resuming = progress?.phase === 'applying' && progress.id === id;
			const state = parseCheckpointState(await optionalText(checkpointStatePath(name)));
			const next = supersededState(plan);
			if (
				checkpointHash(state) !== checkpointHash(plan.state) &&
				!(resuming && checkpointHash(state) === checkpointHash(next))
			)
				throw new Error(
					'Checkpoint changed after the preview. Nothing further was skipped; prepare a new plan.',
				);
			const config = await checkpointConfig(true);
			if ((config ? telegramIdentity(config) : undefined) !== plan.telegram?.key)
				throw new Error('Telegram source changed. No further cursor changes were made.');
			const history = await cachedLocalEvents();
			const remoteHistory = config ? await roomEvents(config) : [];
			const remoteThrough = plan.telegram?.through ?? 0;
			if (
				checkpointHash(history.filter((event) => event.id <= plan.room.through)) !==
					plan.roomHash ||
				(plan.telegram &&
					checkpointHash(
						remoteHistory.filter((event) => event.sequence <= remoteThrough),
					) !== plan.telegramHash)
			)
				throw new Error(
					'Historical source changed after the preview. No further cursor changes were made.',
				);
			if (plan.room.count + (plan.telegram?.count ?? 0) === 0)
				throw new Error('No history lies outside the recent tail. No catch-up is needed.');
			const room = roomCursor((await optionalText(localCursorPath(name))) ?? '0');
			const remote = config
				? roomCursor((await optionalText(roomCursorPath(config, name))) ?? '0')
				: undefined;
			if (
				(!resuming && (room !== plan.room.from || remote !== plan.telegram?.from)) ||
				(resuming && (room < plan.room.from || (remote ?? 0) < (plan.telegram?.from ?? 0)))
			)
				throw new Error(
					'History cursor changed after the preview. Nothing further was skipped.',
				);
			const intent: SkipProgress = { version: 1, id, sha256: digest, phase: 'applying' };
			await atomicWrite(skipPath(name), JSON.stringify(intent));
			// Never pass an unshown page receipt or call recordRead here. Direct mail/holds are untouched.
			// A held Telegram range skips nothing, so its cursor is not touched.
			if (config && plan.telegram && plan.telegram.count > 0)
				await ackRoom(config, String(plan.telegram.through));
			await ackLocalRoom(String(plan.room.through));
			await saveCheckpointState(name, next);
			await atomicWrite(
				skipAppliedPath(name, id),
				JSON.stringify({
					id,
					owner: name,
					sha256: digest,
					appliedAt: new Date().toISOString(),
					disposition: 'skipped',
				}),
			);
			await atomicWrite(skipPath(name), JSON.stringify({ ...intent, phase: 'applied' }));
			return skipView(name, plan);
		}),
	);
}
