import { communicationSend } from './communication-gate.ts';
import { communicationState, setCommunicationPause } from './communication-state.ts';
import { humanHibernationCommand } from './hibernation.ts';
import { appendLocalEvent, localPage } from './local-room.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { currentAgent, operatorOnly } from './mail-identity.ts';
import { compactLocalPage } from './room-catch-up.ts';
import { localCursorPath, roomCursor } from './room-cursor.ts';
import { roomImagePath } from './room-image.ts';
import { loadAgent } from './store.ts';
import { readTeamStartup } from './team-startup.ts';

export async function localAgent(): Promise<string> {
	const name = currentAgent();
	if (!(await loadAgent(name))) throw new Error('Room access requires a registered agent.');
	return name;
}

export async function readLocalRoom(after?: string, compact = false) {
	const name = await localAgent();
	const cursor = roomCursor(after ?? (await optionalText(localCursorPath(name))) ?? '0');
	const page = compact ? await compactLocalPage(cursor, name) : await localPage(cursor);
	return {
		lastTeamWindowStartedAt: await readTeamStartup(),
		paused: (await communicationState()).paused,
		...page,
		events: page.events.map((event) => ({
			...event,
			...(event.image ? { imagePath: roomImagePath(event.image) } : {}),
		})),
	};
}

export async function ackLocalRoom(value: string): Promise<number> {
	const name = await localAgent();
	const cursor = roomCursor(value);
	await localPage(cursor);
	const path = localCursorPath(name);
	return locked(`${path}.lock`, async () => {
		const previous = roomCursor((await optionalText(path)) ?? '0');
		const next = Math.max(previous, cursor);
		await atomicWrite(path, String(next));
		return next;
	});
}

export async function sendLocal(text: string, replyTo: number | null = null) {
	const name = await localAgent();
	return communicationSend('send the Room post', () =>
		appendLocalEvent({ sender: { kind: 'agent', id: name }, text, replyTo, source: 'local' }),
	);
}

export async function sendCliMessage(text: string) {
	operatorOnly();
	if (!text.trim() || text.length > 4096)
		throw new Error('Room messages require 1–4096 characters.');
	await humanHibernationCommand(text);
	return communicationSend('send the Room post', () =>
		appendLocalEvent({
			sender: { kind: 'cli', id: 'CLI' },
			text,
			replyTo: null,
			source: 'local',
		}),
	);
}

export async function sendHuman(text: string, replyTo: number | null = null, image?: string) {
	operatorOnly();
	if ((!text.trim() && !image) || text.length > 4096)
		throw new Error('Room messages require 1–4096 characters.');
	const phrase = text.trim().toLowerCase();
	await humanHibernationCommand(text);
	if (phrase === 'halt' || phrase === 'proceed')
		await setCommunicationPause(phrase === 'halt', 'team-room');
	return appendLocalEvent({
		sender: { kind: 'user', id: 'operator' },
		text,
		replyTo,
		source: 'local',
		...(image ? { image } : {}),
	});
}
