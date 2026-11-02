import { z } from 'zod';

import { readCompactions } from './compaction-history.ts';
import { currentAgent, ownMailbox } from './mail-identity.ts';

export async function compactionCommand(args: string[]): Promise<void> {
	let name = process.env.SUMMON_AGENT ? currentAgent() : undefined;
	let limit = 50;
	let before: string | undefined;
	const used = new Set<string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key || !value || used.has(key))
			throw new Error('Invalid compaction reader arguments.');
		used.add(key);
		if (key === '--member') name = value;
		else if (key === '--limit') limit = z.number().int().min(1).max(200).parse(Number(value));
		else if (key === '--before')
			before = z
				.string()
				.regex(/^[a-f0-9]{64}$/)
				.parse(value);
		else throw new Error('Unknown compaction reader option.');
	}
	if (!name)
		throw new Error(
			'Operator usage: summon --compactions --member name [--limit 1..200] [--before id]',
		);
	ownMailbox(name);
	console.log(JSON.stringify(await readCompactions(name, limit, before)));
}
