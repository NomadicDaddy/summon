import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';

import { missing, optionalText } from './mail-files.ts';

/** Restrict the actual handles before reading on POSIX; Windows keeps its profile ACL policy. */
export async function readTelegramConfig(
	path: string,
	readOnly = false,
): Promise<string | undefined> {
	if (process.platform === 'win32') return optionalText(path);
	try {
		const directory = await open(
			dirname(path),
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		try {
			if (((await directory.stat()).mode & 0o777) !== 0o700) {
				if (readOnly) throw new Error('Unsafe directory permissions.');
				await directory.chmod(0o700);
			}
			const file = await open(
				path,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				const info = await file.stat();
				if (!info.isFile()) throw new Error('Not a regular file.');
				if ((info.mode & 0o777) !== 0o600) {
					if (readOnly) throw new Error('Unsafe file permissions.');
					await file.chmod(0o600);
				}
				return await file.readFile('utf8');
			} finally {
				await file.close();
			}
		} finally {
			await directory.close();
		}
	} catch (error: unknown) {
		if (missing(error)) return undefined;
		throw new Error(
			readOnly
				? 'Telegram configuration requires private permissions before read-only access.'
				: 'Telegram configuration file permissions could not be restricted.',
			{
				cause: error,
			},
		);
	}
}
