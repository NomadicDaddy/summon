import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { errorCode } from './mail-files.ts';
import { storageRoot } from './store.ts';

export const MAX_ROOM_IMAGE = 8 * 1024 * 1024;
export function roomImagePath(id: string): string {
	if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid room image.');
	return join(storageRoot(), 'room', 'images', `${id}.png`);
}

export async function saveRoomImage(png: Buffer): Promise<string> {
	if (!png.length || png.length > MAX_ROOM_IMAGE)
		throw new Error('Room images must be at most 8 MiB.');
	const id = createHash('sha256').update(png).digest('hex');
	await mkdir(join(storageRoot(), 'room', 'images'), { recursive: true, mode: 0o700 });
	try {
		await writeFile(roomImagePath(id), png, { flag: 'wx', mode: 0o600 });
	} catch (error: unknown) {
		if (errorCode(error) !== 'EEXIST') throw error;
	}
	return id;
}

export async function roomImageData(id: string): Promise<string> {
	const png = await readFile(roomImagePath(id));
	if (png.length > MAX_ROOM_IMAGE) throw new Error('Room image exceeds 8 MiB.');
	return `data:image/png;base64,${png.toString('base64')}`;
}
