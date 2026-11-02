import { join } from 'node:path';

import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import { storageRoot } from './store.ts';

export type CommunicationAttribution =
	| { channel: 'cli' | 'team-room'; actor: { kind: 'operator'; id: 'operator' } }
	| { channel: 'telegram'; actor: { kind: 'telegram-user'; id: string } };

export interface CommunicationStatus {
	paused: boolean;
	changedAt: number;
	attribution: CommunicationAttribution | null;
}

interface CommunicationState {
	paused: boolean;
	changedAt: number;
	source: string;
	updates: Record<string, number>;
	attribution?: CommunicationAttribution;
}
const statePath = (): string => join(storageRoot(), 'communications', 'state.json');

function validAttribution(value: unknown): value is CommunicationAttribution {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (!record.actor || typeof record.actor !== 'object' || Array.isArray(record.actor))
		return false;
	const actor = record.actor as Record<string, unknown>;
	if (record.channel === 'cli' || record.channel === 'team-room')
		return actor.kind === 'operator' && actor.id === 'operator';
	return (
		record.channel === 'telegram' &&
		actor.kind === 'telegram-user' &&
		typeof actor.id === 'string' &&
		/^[1-9]\d*$/.test(actor.id)
	);
}

export class CommunicationsPausedError extends Error {
	constructor() {
		super('Halt: mail, local room, and Telegram sends are paused until the user says proceed.');
	}
}
export async function communicationState(): Promise<CommunicationState> {
	const raw = await optionalText(statePath());
	if (!raw) return { paused: false, changedAt: 0, source: '', updates: {} };
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== 'object')
		throw new Error('Invalid communication state; refusing to send.');
	const state = value as Record<string, unknown>;
	if (
		typeof state.paused !== 'boolean' ||
		typeof state.changedAt !== 'number' ||
		!Number.isFinite(state.changedAt) ||
		typeof state.source !== 'string' ||
		!state.updates ||
		typeof state.updates !== 'object' ||
		Array.isArray(state.updates) ||
		!Object.values(state.updates).every((id: unknown) => Number.isSafeInteger(id)) ||
		(state.attribution !== undefined && !validAttribution(state.attribution))
	)
		throw new Error('Invalid communication state; refusing to send.');
	return value as CommunicationState;
}
export async function communicationStatus(): Promise<CommunicationStatus> {
	const { paused, changedAt, attribution } = await communicationState();
	const known: CommunicationAttribution | null = attribution
		? attribution.channel === 'telegram'
			? { channel: 'telegram', actor: { kind: 'telegram-user', id: attribution.actor.id } }
			: { channel: attribution.channel, actor: { kind: 'operator', id: 'operator' } }
		: null;
	return { paused, changedAt, attribution: known };
}
export async function assertCommunicationsOpen(): Promise<void> {
	if ((await communicationState()).paused) throw new CommunicationsPausedError();
}

export async function setCommunicationPause(
	paused: boolean,
	channel: 'cli' | 'team-room' = 'cli',
): Promise<void> {
	operatorOnly();
	await locked(`${statePath()}.lock`, async () => {
		const state = await communicationState();
		await atomicWrite(
			statePath(),
			JSON.stringify({
				...state,
				paused,
				changedAt: Date.now(),
				source: 'local',
				attribution: { channel, actor: { kind: 'operator', id: 'operator' } },
			}),
		);
	});
}

/** Called only after Telegram chat and human sender validation, never from peer mail or bot text. */
export async function applyTelegramSignal(
	botId: string,
	updateId: number,
	date: unknown,
	text: string,
	senderId: string,
): Promise<void> {
	const phrase = text.trim().toLowerCase();
	if (phrase !== 'halt' && phrase !== 'proceed') return;
	if (!/^[1-9]\d*$/.test(senderId)) throw new Error('Invalid Telegram operator identity.');
	await locked(`${statePath()}.lock`, async () => {
		const state = await communicationState();
		if (updateId <= (state.updates[botId] ?? -1)) return;
		state.updates[botId] = updateId;
		// An old queued proceed must not undo a more recent local pause. Fail closed within
		// the same timestamp second; a fresh proceed sent afterward will resume normally.
		const staleClear =
			phrase === 'proceed' &&
			state.paused &&
			state.source !== `telegram:${botId}` &&
			(!Number.isSafeInteger(date) || Number(date) * 1000 <= state.changedAt);
		if (!staleClear) {
			state.paused = phrase === 'halt';
			state.changedAt = Date.now();
			state.source = `telegram:${botId}`;
			state.attribution = {
				channel: 'telegram',
				actor: { kind: 'telegram-user', id: senderId },
			};
		}
		await atomicWrite(statePath(), JSON.stringify(state));
	});
}

export async function communicationCommand(args: string[]): Promise<void> {
	if (args.length !== 1 || !['halt', 'proceed', 'status'].includes(args[0] ?? ''))
		throw new Error('Usage: summon --comms halt|proceed|status');
	if (args[0] !== 'status') await setCommunicationPause(args[0] === 'halt');
	console.log(
		(await communicationState()).paused
			? 'Halt: mail and Telegram sends paused.'
			: 'Proceed: mail and Telegram sends allowed.',
	);
}
