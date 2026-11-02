import { clipboard, ipcMain, nativeImage } from 'electron';

import type { RoomImage } from './types.ts';

import { cachedLocalEvents } from '../local-room.ts';
import { MAX_ROOM_IMAGE, roomImageData, saveRoomImage } from '../room-image.ts';

/** One set of bounds for an image coming in and one going out. */
function checkedSize(image: Electron.NativeImage): { height: number; width: number } {
	const { width, height } = image.getSize();
	if (
		image.isEmpty() ||
		width <= 0 ||
		height <= 0 ||
		width > 8192 ||
		height > 8192 ||
		width * height > 32000000
	)
		throw new Error('Image is empty or exceeds 8192 pixels / 32 megapixels.');
	return { height, width };
}

function normalizedImage(data: unknown): Buffer {
	if (
		typeof data !== 'string' ||
		data.length > MAX_ROOM_IMAGE * 1.4 ||
		!/^data:image\/(png|jpeg|webp);base64,/.test(data)
	)
		throw new Error('Paste a PNG, JPEG or WebP image up to 8 MiB.');
	const image = nativeImage.createFromDataURL(data);
	checkedSize(image);
	const png = image.toPNG();
	if (png.length > MAX_ROOM_IMAGE) throw new Error('PNG image exceeds 8 MiB.');
	return png;
}

export async function persistImage(data: unknown): Promise<string | undefined> {
	return data === undefined || data === null ? undefined : saveRoomImage(normalizedImage(data));
}

export function roomImageIpc(trusted: (event: Electron.IpcMainInvokeEvent) => void): void {
	ipcMain.handle('team:clipboard-image', async (event) => {
		trusted(event);
		const item = (await clipboard.read()).find((entry) => entry.types.includes('image/png'));
		if (!item) throw new Error('No image on the clipboard.');
		const blob = await item.getType('image/png');
		if (!('arrayBuffer' in blob) || blob.size > MAX_ROOM_IMAGE)
			throw new Error('Room images must be at most 8 MiB.');
		const raw = Buffer.from(await blob.arrayBuffer());
		const png = normalizedImage(`data:image/png;base64,${raw.toString('base64')}`);
		return `data:image/png;base64,${png.toString('base64')}`;
	});
	ipcMain.handle('team:room-image', async (event, id: unknown) => {
		trusted(event);
		if (
			typeof id !== 'string' ||
			!(await cachedLocalEvents()).some((item) => item.image === id)
		)
			throw new Error('Image is not attached to a room message.');
		// The size travels with the data so the room can reserve the image's box before it paints;
		// without it a pinned log grew by up to 480px after it had scrolled, and stopped following.
		// Read from the stored PNG as it is: decoded once, never re-encoded or rewritten.
		const data = await roomImageData(id);
		const { height, width } = checkedSize(nativeImage.createFromDataURL(data));
		return { data, height, width } satisfies RoomImage;
	});
}
