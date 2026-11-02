import { lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { missing } from './mail-files.ts';

async function signature(path: string): Promise<string> {
	const info = await lstat(path, { bigint: true }).catch((error: unknown) => {
		if (missing(error)) return undefined;
		throw error;
	});
	return info
		? `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
		: 'missing';
}

/** Invalidate bounded results on live writes, archive replacement, removal or addition. */
async function historySignature(path: string): Promise<string> {
	const root = join(dirname(path), 'archive');
	const entries = await readdir(root).catch((error: unknown) => {
		if (missing(error)) return [];
		throw error;
	});
	const archives = entries.filter((name) => /^events-\d+-\d+-[a-f0-9]{64}\.json$/.test(name));
	archives.sort();
	return JSON.stringify([
		path,
		await signature(path),
		await signature(root),
		...(await Promise.all(
			archives.map(async (name) => [name, await signature(join(root, name))]),
		)),
	]);
}

/** One result per query family; callers control its size. Cache only validated stable snapshots. */
export function roomQueryCache<T>() {
	let saved: { key: string; signature: string; value: T } | undefined;
	return async (path: string, key: string, read: () => Promise<T>): Promise<T> => {
		const before = await historySignature(path);
		if (saved?.key === key && saved.signature === before) return saved.value;
		const value = await read();
		saved =
			before === (await historySignature(path))
				? { key, signature: before, value }
				: undefined;
		return value;
	};
}
