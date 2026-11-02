import { constants } from 'node:fs';
import { lstat, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { operatorOnly } from './mail-identity.ts';
import { slugFor, storageRoot } from './store.ts';
import { readTeammateGallery } from './teammate-gallery.ts';

/** Resolve a content ID before creation; never accept a renderer-supplied path. */
export async function galleryAvatar(
	directory: string,
	value: unknown,
	existing: string | null,
): Promise<Buffer | undefined> {
	operatorOnly();
	if (!value || typeof value !== 'object') return undefined;
	const id = (value as Record<string, unknown>).galleryId;
	if (id === undefined || id === '') return undefined;
	if (existing !== null) throw new Error('Gallery icons apply only when creating a member.');
	if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
		throw new Error('Invalid gallery identity.');
	if ((id === 'project-manager') !== ((value as Record<string, unknown>).memberType === 'pm'))
		throw new Error('Gallery identity does not match the member type.');
	const gallery = await readTeammateGallery(directory);
	if (id !== 'project-manager' && !gallery.templates.some((template) => template.id === id))
		throw new Error('Gallery identity is no longer available; choose a current starter.');
	try {
		const folder = await lstat(directory);
		if (!folder.isDirectory() || folder.isSymbolicLink())
			throw new Error('Redirected gallery.');
		const path = join(directory, `${id}.png`);
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 262144)
			throw new Error('Invalid icon file.');
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const current = await file.stat();
			if (!current.isFile() || current.size > 262144) throw new Error('Invalid icon file.');
			const bytes = Buffer.alloc(262145);
			const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
			if (
				bytesRead < 33 ||
				bytesRead > 262144 ||
				bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
				bytes.readUInt32BE(8) !== 13 ||
				bytes.toString('ascii', 12, 16) !== 'IHDR'
			)
				throw new Error('Invalid PNG header.');
			const width = bytes.readUInt32BE(16);
			if (width < 32 || width > 512 || bytes.readUInt32BE(20) !== width)
				throw new Error('Icon must be square, 32 to 512 pixels.');
			return bytes.subarray(0, bytesRead);
		} finally {
			await file.close();
		}
	} catch {
		console.warn(`Gallery icon unavailable for ${id}; the new member will use initials.`);
		return undefined;
	}
}

/** Exclusive creation preserves custom avatars and rejects redirected destinations. */
export async function installGalleryAvatar(name: string, bytes: Buffer | undefined): Promise<void> {
	operatorOnly();
	if (!bytes) return;
	try {
		await writeFile(join(storageRoot(), `${slugFor(name)}.png`), bytes, { flag: 'wx' });
	} catch {
		console.warn(
			`Gallery icon was not installed for ${slugFor(name)}; existing files were preserved.`,
		);
	}
}
