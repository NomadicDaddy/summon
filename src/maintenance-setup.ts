import { join } from 'node:path';

import { atomicWrite, locked, optionalText } from './mail-files.ts';

/** Same lock as maintenance: a competing setup cannot publish over a runnable command. */
export async function installMaintenanceCommand(
	directory: string,
	config: string,
	bundle: () => Promise<string>,
): Promise<void> {
	await locked(join(directory, 'update.lock'), async () => {
		for (const name of ['config.json', 'update.js', 'state.json']) {
			if ((await optionalText(join(directory, name))) !== undefined)
				throw new Error(
					`Standing updater file ${name} already exists; preserve installation and rollback state. See setup recovery in README.`,
				);
		}
		const source = await bundle();
		// Config is the publication marker. An interrupted first write is retained and refused.
		await atomicWrite(join(directory, 'update.js'), source);
		await atomicWrite(join(directory, 'config.json'), config);
	});
}
