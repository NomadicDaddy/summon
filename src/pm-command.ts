import { resolve } from 'node:path';

import { operatorOnly } from './mail-identity.ts';
import { acquireSessionLock } from './session-lock.ts';
import { isProvider, loadAgent, newRecord, saveAgent, slugFor } from './store.ts';

/** Register at startup or later; the normal launch path remains the immediate consumer. */
export async function preparePm(args: string[]): Promise<string> {
	operatorOnly();
	const name = (args[0] && !args[0].startsWith('--') ? args.shift() : undefined) ?? 'Steward';
	let provider = 'codex';
	if (args.length) {
		if (args.length !== 2 || args[0] !== '--using' || !isProvider(args[1]))
			throw new Error('Usage: summon --pm [name] [--using claude|codex|grok|kilo]');
		provider = args[1];
	}
	if (!isProvider(provider)) throw new Error('Invalid PM provider.');
	const slug = slugFor(name);
	const existing = await loadAgent(slug);
	if (existing && existing.memberType !== 'pm')
		throw new Error('That name belongs to an ordinary teammate.');
	if (existing && args.length && existing.provider !== provider)
		throw new Error('Change an existing PM provider in Maintenance while it is stopped.');
	if (!existing) {
		// A reused name can still have a live session from a hand-deleted registration. Creating
		// the record seeds its cursors, so hold the name's session lock as the CLI does; the launch
		// that follows takes it again once this releases it.
		const lock = await acquireSessionLock(slug);
		if (!lock)
			throw new Error(
				`A session is still running under the name ${name}; stop it before registering the name again.`,
			);
		try {
			const record = newRecord(name, resolve(process.cwd()), provider);
			record.memberType = 'pm';
			record.displayName = name;
			record.canStopResting = false;
			await saveAgent(slug, record, true);
		} finally {
			await lock.release();
		}
	}
	return slug;
}
