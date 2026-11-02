import { expect, test } from 'bun:test';

/*
 * A room image used to arrive with no size after an IPC round trip and grow by up to 480px once the
 * log had scrolled, so a pinned room silently stopped following. The window probe exercises the
 * three cases (pinned image then text, already scrolled up, scrolled up while the image is pending);
 * this pins the contract that makes them hold.
 */
const read = (path: string): Promise<string> => Bun.file(`src/desktop/${path}`).text();

test('the image handler returns the stored size with the data, behind the same checks', async () => {
	const handler = await read('room-images.ts');
	const at = handler.indexOf("ipcMain.handle('team:room-image'");
	const body = handler.slice(at, handler.indexOf('});', at));
	// Trusted sender first, then attached-to-a-message, then the read with its 8 MiB limit.
	expect(body.indexOf('trusted(event);')).toBeLessThan(body.indexOf('item.image === id'));
	expect(body).toContain('await roomImageData(id)');
	expect(body).toContain('checkedSize(nativeImage.createFromDataURL(data))');
	expect(body).toContain('return { data, height, width } satisfies RoomImage;');
	// Read as stored: no re-encode, no write.
	expect(body).not.toContain('toPNG');
	expect(body).not.toContain('saveRoomImage');
	// One set of bounds in and out.
	expect(handler.match(/width > 8192/gu)).toHaveLength(1);
	expect(handler).toContain('width <= 0 ||');
});

test('the box is reserved before src, and only a following reader is re-pinned', async () => {
	const [attachments, room, bridge] = await Promise.all([
		read('room-attachments.ts'),
		read('room.ts'),
		read('types.ts'),
	]);
	expect(bridge).toContain('roomImage: (id: string) => Promise<RoomImage>;');
	const sized = attachments.indexOf('image.height = height;');
	expect(sized).toBeGreaterThan(-1);
	expect(sized).toBeLessThan(attachments.indexOf('image.src = data;'));
	expect(attachments).toContain("image.addEventListener('load', keepFollowing);");
	// Following changes only on scroll, so a late image cannot override a reader who scrolled away.
	expect(room).toContain("messages.addEventListener('scroll', () => {");
	expect(room).toContain('if (following) messages.scrollTop = messages.scrollHeight;');
	expect(room).toContain('appendRoomImage(item, event.image, keepFollowing)');
});
