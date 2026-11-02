import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { summonStorageLayout } from '../package.json';
import { missing } from './mail-files.ts';
import { teamDist } from './team-build-options.ts';

/** Refuse the old receipt position before an existing bundle can receive the new launch ABI. */
export async function assertTeamBuildLayout(directory = teamDist): Promise<void> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(join(directory, 'build.json'), 'utf8')) as unknown;
	} catch (error: unknown) {
		if (!missing(error) && !(error instanceof SyntaxError)) throw error;
	}
	if (!z.object({ storageLayout: z.literal(summonStorageLayout) }).safeParse(raw).success)
		throw new Error(
			'Team window bundle has an incompatible storage launch layout. Run bun run build:team from the compatible checkout before opening it.',
		);
}
