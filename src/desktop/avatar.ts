import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

import { slugFor, storageRoot } from '../store.ts';

const avatars = new Map<string, { signature: string; value: string | undefined }>();

/** Retain only the current roster, including owned sessions without a registration. */
export function retainAvatars(names: Iterable<string>): void {
	const paths = new Set([...names].map((name) => join(storageRoot(), `${slugFor(name)}.png`)));
	for (const path of avatars.keys()) if (!paths.has(path)) avatars.delete(path);
}

/** Optional square PNG, 32–512 pixels, at most 256 KiB. Invalid images keep initials. */
export async function avatarFor(name: string): Promise<string | undefined> {
	const path = join(storageRoot(), `${slugFor(name)}.png`);
	try {
		const info = await lstat(path, { bigint: true });
		if (!info.isFile() || info.isSymbolicLink() || info.size > 262144n) {
			avatars.delete(path);
			return undefined;
		}
		const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
		const cached = avatars.get(path);
		if (cached?.signature === signature) return cached.value;
		avatars.delete(path);
		const file = await open(path, 'r');
		try {
			const bytes = Buffer.alloc(262145);
			const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
			if (
				bytesRead < 33 ||
				bytesRead > 262144 ||
				bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
				bytes.readUInt32BE(8) !== 13 ||
				bytes.toString('ascii', 12, 16) !== 'IHDR'
			)
				return undefined;
			const width = bytes.readUInt32BE(16);
			if (width < 32 || width > 512 || bytes.readUInt32BE(20) !== width) return undefined;
			const value = `data:image/png;base64,${bytes.subarray(0, bytesRead).toString('base64')}`;
			const after = await file.stat({ bigint: true });
			if (
				`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` ===
				signature
			)
				avatars.set(path, { signature, value });
			return value;
		} finally {
			await file.close();
		}
	} catch {
		avatars.delete(path);
		return undefined;
	}
}
