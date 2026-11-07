import { randomUUID } from 'node:crypto';

import type { CheckpointPackage, CheckpointState } from './checkpoint-package-model.ts';

import { checkpointOutput, checkpointTransport } from './checkpoint-output.ts';
import { checkpointConfig, telegramIdentity } from './checkpoint-package-capture.ts';
import {
	checkpointHash,
	checkpointId,
	checkpointTelegramError,
	parseCheckpointState,
} from './checkpoint-package-model.ts';
import {
	checkpointStatePath,
	loadCheckpointPackage,
	newCheckpointPackage,
	saveCheckpointState,
} from './checkpoint-package-store.ts';
import { requireSettledCatchUp } from './checkpoint-skip-progress.ts';
import { checkpointWork } from './checkpoint-work.ts';
import { dailyClaims } from './claims.ts';
import { communicationState } from './communication-state.ts';
import { HIBERNATE_INSTRUCTION, isHibernated } from './hibernation.ts';
import { ackLocalRoom, localAgent } from './local-room-access.ts';
import { locked, optionalText } from './mail-files.ts';
import { recordRead } from './mail-read.ts';
import { recoverReadProjections } from './mail-sent-status.ts';
import { ackRoom } from './telegram.ts';

function receiptError(kind: 'Invalid' | 'Unknown'): Error {
	return new Error(
		`${kind} checkpoint receipt. No checkpoint cursors advanced. Unseen messages remain unread. Run summon --checkpoint without a receipt to recover the pending batch, read it completely, then pass its returned receipt. For a repeated mismatch, inspect summon --checkpoint manifest for the current receipt position; preserve the retained output.`,
	);
}

async function acknowledge(
	name: string,
	state: CheckpointState,
	packet: CheckpointPackage,
	token: string,
): Promise<void> {
	const current = state.current;
	if (!current) throw receiptError('Unknown');
	const page = packet.pages[current.page];
	if (page) {
		if (page.receipt !== token) throw receiptError('Unknown');
		for (const mail of page.completeMail) await recordRead(name, mail);
		state.current = { ...current, page: current.page + 1 };
	} else {
		if (packet.finalReceipt !== token) throw receiptError('Unknown');
		const config = await checkpointConfig();
		if (
			packet.sources.telegram &&
			(!config || telegramIdentity(config) !== packet.sources.telegram.key)
		)
			throw new Error(
				'Telegram source changed during this package. Nothing was acknowledged. Restore the source before retrying the final receipt.',
			);
		if (packet.sources.telegram && config)
			await ackRoom(config, String(packet.sources.telegram.through));
		await ackLocalRoom(String(packet.sources.room.through));
		Object.assign(state.seenHolds, packet.sources.holds);
		state.completedPackage = packet.id;
		delete state.current;
	}
	state.lastAck = token;
	await saveCheckpointState(name, state);
}

/** Page receipts cover exactly delivered bytes; only the final receipt commits frozen cursors. */
export async function checkpoint(token?: string, work = false): Promise<Record<string, unknown>> {
	const name = await localAgent();
	if (await isHibernated(name))
		return {
			hibernated: true,
			changed: false,
			more: false,
			instruction: HIBERNATE_INSTRUCTION,
		};
	await dailyClaims(name);
	await recoverReadProjections(name);
	if (token !== undefined && !checkpointId.safeParse(token).success)
		throw receiptError('Invalid');
	return locked(`${checkpointStatePath(name)}.lock`, async () => {
		await requireSettledCatchUp(name);
		const state = parseCheckpointState(await optionalText(checkpointStatePath(name)));
		let packet = await loadCheckpointPackage(name, state);
		const repeated = token !== undefined && token === state.lastAck;
		const emptyAcknowledgment = token !== undefined && token === state.emptyReceipt;
		const replay = !!packet;
		let completedPackage = false;
		if (token !== undefined && !repeated) {
			if (emptyAcknowledgment) {
				state.lastAck = token;
				delete state.emptyReceipt;
				await saveCheckpointState(name, state);
			} else {
				if (!packet) throw receiptError('Unknown');
				await acknowledge(name, state, packet, token);
				if (!state.current) {
					packet = undefined;
					completedPackage = true;
				}
			}
		}
		// Do not chain a fresh package into the work package's final acknowledgement.
		// Quiet receipts and repeated acknowledgements must still capture new arrivals.
		if (work && completedPackage) {
			return {
				paused: (await communicationState()).paused,
				changed: false,
				more: false,
				sourcesRefreshed: false,
				work: checkpointWork(true),
			};
		}
		let telegramRefreshError: string | undefined;
		packet ??= await newCheckpointPackage(name, state, (reason) => {
			telegramRefreshError = reason;
		});
		telegramRefreshError = packet ? checkpointTelegramError(packet) : telegramRefreshError;
		const transport = checkpointTransport(telegramRefreshError);
		const paused = (await communicationState()).paused;
		if (!packet) {
			state.emptyReceipt ??= randomUUID();
			await saveCheckpointState(name, state);
			return {
				paused,
				receipt: state.emptyReceipt,
				changed: false,
				more: false,
				...transport,
			};
		}
		return checkpointOutput(
			packet,
			state,
			paused,
			work,
			telegramRefreshError,
			repeated
				? 'acknowledged'
				: replay && (token === undefined || emptyAcknowledgment)
					? 'issued'
					: undefined,
		);
	});
}

export async function checkpointManifest(cursor = '0'): Promise<Record<string, unknown>> {
	const name = await localAgent();
	if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
		throw new Error('Invalid manifest cursor.');
	return locked(`${checkpointStatePath(name)}.lock`, async () => {
		const state = parseCheckpointState(await optionalText(checkpointStatePath(name)));
		const packet = await loadCheckpointPackage(name, state);
		if (!packet)
			return {
				items: [],
				next: null,
				instruction: 'No active package. Run summon --checkpoint.',
			};
		const start = Number(cursor);
		if (start > packet.items.length)
			throw new Error('Manifest cursor exceeds package inventory.');
		const items = packet.items.slice(start, start + 20);
		const telegramRefreshError = checkpointTelegramError(packet);
		const page = state.current?.page ?? 0;
		return {
			id: packet.id,
			createdAt: packet.createdAt,
			position: {
				phase: packet.pages[page] ? 'page' : 'final',
				page: Math.min(page + 1, packet.pages.length),
				receiptSha256: checkpointHash(packet.pages[page]?.receipt ?? packet.finalReceipt),
			},
			...(telegramRefreshError
				? {
						telegramRefreshError,
						telegramFresh: false,
						transportWarning:
							'Capture used local and cached records only; unseen remote updates remain pending.',
					}
				: {}),
			pages: packet.pages.length,
			sources: {
				room: packet.sources.room,
				telegram: packet.sources.telegram,
				holds: Object.keys(packet.sources.holds).length,
			},
			items,
			next: start + items.length < packet.items.length ? String(start + items.length) : null,
			instruction:
				'Zero-based page ranges. SHA-256 and bytes identify canonical JSON presentation before same-page mirror omission; restore bodyInRoom from that exact room event. Index only: read every page; receipts do not approve or complete work.',
		};
	});
}
