import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeClaudeTurn } from '../../src/claude-turn-state.ts';
import { initializeGrokTurn } from '../../src/grok-turn-state.ts';
import { initializeKiloTurn } from '../../src/kilo-turn-state.ts';
import { deliveryStatus } from '../../src/mail-session.ts';
import { observeFixtureClaudeIdle } from './wake-team.ts';

/** Explicit observed-idle turn evidence for rest tests whose subject is not turn observation.
 * The idle question treats a missing Claude, Grok or Kilo turn record as unknown, so a test
 * expecting the question needs this launch's idle record first. Codex uses bindIdleCodex.
 */
export async function bindIdleTurn(
	root: string,
	provider: 'claude' | 'grok' | 'kilo',
	name: string,
	nonce: string,
): Promise<void> {
	// The launch's own delivery thread, or attachFixtureReceiver's, so a receiver attached later
	// accepts this record.
	const thread = (await deliveryStatus(name, nonce)).thread || 'disposable-thread';
	if (provider === 'claude') {
		await initializeClaudeTurn(name, nonce, thread, 'fixture-observer');
		await observeFixtureClaudeIdle(name, nonce);
		return;
	}
	if (provider === 'grok') await initializeGrokTurn(name, nonce, thread);
	else await initializeKiloTurn(name, nonce, thread);
	const path = join(root, 'runtime', name, `${nonce}.${provider}-turn`);
	const turn = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
	// A Kilo notice also needs a settled startup turn (Phillip #22057); Grok's record has no field.
	await writeFile(
		path,
		JSON.stringify({
			...turn,
			phase: 'idle',
			...(provider === 'kilo' ? { startup: 'accepted' } : {}),
		}),
	);
}
