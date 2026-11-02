import { stat } from 'node:fs/promises';

import { missing } from './mail-files.ts';

/** Cache receiver reads only; writers always read the durable file afresh under their lock. */
export function roomCache<T>(
	retain: (value: T) => boolean = () => true,
): (path: string, read: () => Promise<T>) => Promise<T> {
	let saved: { path: string; signature: string; value: T } | undefined;
	const signature = async (path: string): Promise<string | undefined> => {
		try {
			const info = await stat(path, { bigint: true });
			return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
		} catch (error: unknown) {
			if (missing(error)) return undefined;
			throw error;
		}
	};
	return async (path, read) => {
		const before = await signature(path);
		if (before !== undefined && saved?.path === path && saved.signature === before)
			return saved.value;
		const value = await read();
		saved =
			before !== undefined && retain(value) && before === (await signature(path))
				? { path, signature: before, value }
				: undefined;
		return value;
	};
}
