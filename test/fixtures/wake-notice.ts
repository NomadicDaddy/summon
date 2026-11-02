import type { WakePart } from '../../src/wake-part.ts';

import { automaticNoticeSuppressed } from '../../src/automatic-notice.ts';
import { prepareLocalRoomNotice } from '../../src/local-room-live.ts';
import { pollWakeTelegram, prepareTelegramNotice } from '../../src/telegram-live.ts';
import { deliverWakeParts } from '../../src/wake-delivery.ts';

async function deliver(
	name: string,
	nonce: string,
	part: WakePart | undefined,
	send: (text: string) => Promise<void>,
): Promise<void> {
	if (!part) return;
	await deliverWakeParts(
		name,
		nonce,
		[part],
		send,
		async () => !(await automaticNoticeSuppressed(name)),
	);
}

export async function notifyLocalRoom(
	name: string,
	nonce: string,
	send: (text: string) => Promise<void>,
): Promise<void> {
	if (await automaticNoticeSuppressed(name)) return;
	await deliver(name, nonce, await prepareLocalRoomNotice(name, nonce), send);
}

export async function notifyRoom(
	name: string,
	nonce: string,
	send: (text: string) => Promise<void>,
): Promise<void> {
	await pollWakeTelegram(name);
	if (await automaticNoticeSuppressed(name)) return;
	await deliver(name, nonce, await prepareTelegramNotice(name, nonce), send);
}
