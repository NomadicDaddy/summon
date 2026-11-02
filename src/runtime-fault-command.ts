import { z } from 'zod';

import { readRuntimeFaults } from './runtime-faults.ts';
import { slugFor } from './store.ts';

export async function runtimeFaultCommand(args: string[]): Promise<void> {
	const options: { limit: number; member?: string; since?: string } = { limit: 50 };
	const used = new Set<string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key || !value || used.has(key))
			throw new Error(
				'Usage: summon --faults [--limit 1..200] [--member name] [--since ISO-time]',
			);
		used.add(key);
		if (key === '--limit')
			options.limit = z.number().int().min(1).max(200).parse(Number(value));
		else if (key === '--member') options.member = slugFor(value);
		else if (key === '--since') options.since = z.iso.datetime({ offset: true }).parse(value);
		else throw new Error('Unknown runtime fault reader option.');
	}
	console.log(JSON.stringify(await readRuntimeFaults(options)));
}
