import { join } from 'node:path';

import type { ModelInfo } from './model-info.ts';

import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { runtimePath } from './mail-session.ts';
import { validModelInfo } from './model-info.ts';

/** Persist observed model transitions; timestamps and sessions alone are not changes. */
export async function recordModelHistory(slug: string, info: ModelInfo): Promise<void> {
	if (!validModelInfo(info)) throw new Error('Invalid model history observation.');
	const path = join(runtimePath(slug), 'model-history.jsonl');
	await locked(`${path}.lock`, async () => {
		const text = (await optionalText(path)) ?? '';
		const line = text.trimEnd().split('\n').at(-1);
		if (line) {
			const previous: unknown = JSON.parse(line);
			if (!validModelInfo(previous)) throw new Error('Invalid model history entry.');
			if (
				previous.provider === info.provider &&
				previous.model === info.model &&
				previous.reasoning === info.reasoning &&
				previous.contextWindow === info.contextWindow
			)
				return;
		}
		const entry = { ...info, loggedAt: new Date().toISOString() };
		await atomicWrite(
			path,
			`${text}${text && !text.endsWith('\n') ? '\n' : ''}${JSON.stringify(entry)}\n`,
		);
	});
}
