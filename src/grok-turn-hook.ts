import { retainGrokCompaction } from './compaction-observers.ts';
import { ownsGrokHook } from './grok-hook-lease.ts';
import { observeGrokTurn } from './grok-turn-state.ts';
import { assertStorageLayout } from './storage-layout.ts';

// The provider may include private prompt/tool fields. Retain none of them and emit no payload.
if (process.env.SUMMON_AGENT && process.env.SUMMON_NONCE) {
	try {
		const text = await Bun.stdin.text();
		if (Buffer.byteLength(text) <= 1_000_000) {
			const input: unknown = JSON.parse(text);
			if (
				input &&
				typeof input === 'object' &&
				'sessionId' in input &&
				input.sessionId === process.env.SUMMON_GROK_SESSION
			) {
				await assertStorageLayout();
				if (!(await ownsGrokHook(process.env.SUMMON_AGENT, process.env.SUMMON_NONCE)))
					process.exit(0);
				await observeGrokTurn(process.env.SUMMON_AGENT, process.env.SUMMON_NONCE, input);
				await retainGrokCompaction(
					process.env.SUMMON_AGENT,
					process.env.SUMMON_NONCE,
					input,
				);
			}
		}
	} catch {
		console.error('Summon turn observation unavailable; ordinary notices remain queued.');
	}
}
