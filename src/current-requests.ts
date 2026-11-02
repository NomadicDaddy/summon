import type { CheckpointInput } from './checkpoint-package-pages.ts';
import type { CurrentRequestBoundary } from './current-request-cursor.ts';

import { checkpointConfig, telegramIdentity } from './checkpoint-package-capture.ts';
import { checkpointHash } from './checkpoint-package-model.ts';
import { checkpointPages } from './checkpoint-package-pages.ts';
import { CHECKPOINT_CATCH_UP_HOLD } from './checkpoint-work.ts';
import {
	decodeCurrentRequestCursor,
	encodeCurrentRequestCursor,
} from './current-request-cursor.ts';
import { currentMailInputs } from './current-request-mail.ts';
import {
	currentRoomInputs,
	currentTelegramInputs,
	interleaveCurrentInputs,
} from './current-request-selection.ts';
import { localAgent } from './local-room-access.ts';
import { cachedLocalEvents } from './local-room.ts';
import { optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { localCursorPath, roomCursor } from './room-cursor.ts';
import { roomImagePath } from './room-image.ts';
import { storageRoot } from './store.ts';
import { roomCursorPath } from './telegram-live.ts';
import { roomEvents } from './telegram-room.ts';

const expired = () =>
	new Error(
		'Current-request snapshot changed or expired. Start summon --current-requests again; checkpoint receipts are unchanged.',
	);

/** Independent read-only bodies. This never creates, advances or acknowledges a checkpoint. */
export async function currentRequests(token?: string): Promise<Record<string, unknown>> {
	const name = await localAgent();
	ownMailbox(name);
	const cursor = token === undefined ? undefined : decodeCurrentRequestCursor(token);
	if (cursor && (cursor.owner !== name || cursor.root !== checkpointHash(storageRoot())))
		throw expired();
	const history = await cachedLocalEvents();
	const config = await checkpointConfig(true);
	const telegram = config ? await roomEvents(config) : [];
	const boundary: CurrentRequestBoundary = cursor ?? {
		version: 1,
		owner: name,
		root: checkpointHash(storageRoot()),
		capturedAt: new Date().toISOString(),
		roomFrom: roomCursor((await optionalText(localCursorPath(name))) ?? '0'),
		roomThrough: history.at(-1)?.id ?? 0,
		...(config
			? {
					telegram: {
						key: telegramIdentity(config),
						from: roomCursor((await optionalText(roomCursorPath(config, name))) ?? '0'),
						through: telegram.at(-1)?.sequence ?? 0,
					},
				}
			: {}),
	};
	if (
		boundary.roomFrom > boundary.roomThrough ||
		boundary.roomThrough > history.length ||
		(config ? telegramIdentity(config) : undefined) !== boundary.telegram?.key
	)
		throw expired();
	const room = history.filter((event) => event.id <= boundary.roomThrough);
	const localInputs = currentRoomInputs(name, room, boundary.roomFrom);
	let telegramInputs: CheckpointInput[] = [];
	if (boundary.telegram) {
		if (
			boundary.telegram.from > boundary.telegram.through ||
			boundary.telegram.through > (telegram.at(-1)?.sequence ?? 0)
		)
			throw expired();
		const { through, from } = boundary.telegram;
		telegramInputs = currentTelegramInputs(
			name,
			telegram.filter((event) => event.sequence <= through),
			from,
			room,
		);
	}
	const inputs = interleaveCurrentInputs([
		localInputs,
		await currentMailInputs(name, boundary.capturedAt),
		telegramInputs,
	]);
	for (const input of inputs)
		if (input.source === 'room' && input.value.image)
			input.value = { ...input.value, imagePath: roomImagePath(input.value.image) };
	const fingerprint = checkpointHash(inputs);
	if (cursor && cursor.hash !== fingerprint) throw expired();
	const rendered = checkpointPages(
		inputs,
		{
			roomThrough: boundary.roomFrom,
			telegramThrough: boundary.telegram?.from ?? 0,
			startedAt: null,
			paused: false,
			sources: {
				room: { from: boundary.roomFrom, through: boundary.roomThrough },
				holds: {},
			},
			...(config ? { config } : {}),
		},
		'current-requests',
	);
	const page = cursor?.page ?? 0;
	if (page >= rendered.pages.length && (page > 0 || inputs.length > 0)) throw expired();
	const payload = { ...rendered.pages[page]?.payload };
	for (const source of ['room', 'telegram']) {
		const section = payload[source];
		if (section && typeof section === 'object' && 'events' in section)
			payload[source] = { events: section.events };
	}
	return {
		readOnly: true,
		snapshotOnly: true,
		owner: name,
		capturedAt: boundary.capturedAt,
		...payload,
		page: inputs.length ? page + 1 : 0,
		pages: rendered.pages.length,
		next:
			page + 1 < rendered.pages.length
				? encodeCurrentRequestCursor({ ...boundary, page: page + 1, hash: fingerprint })
				: null,
		instruction:
			'Read exact request bodies, JSON fragments and linked reply/approval context before acting. This is not approval, handling, mail read coverage or a checkpoint receipt. For mail confirmation use read-self first. Continue normal checkpoint with its retained receipt, or use the explicit catch-up preview/apply operation for old routine history. Never manufacture receipt coverage. A fresh summon --current-requests includes later arrivals, even during a frozen checkpoint. ' +
			CHECKPOINT_CATCH_UP_HOLD,
	};
}
