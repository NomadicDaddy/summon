import { mock } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Explicit loaded-idle prerequisite for rest tests whose subject is not turn observation.
 * The file-isolated runner keeps this RPC mock out of the busy/unknown protocol controls.
 */
export async function bindIdleCodex(root: string, name: string, nonce: string): Promise<void> {
	await mock.module('../../src/codex-turn-rpc.ts', () => ({
		readCodexThreadStatuses: (threads: readonly string[]) =>
			Promise.resolve(new Map(threads.map((thread) => [thread, 'idle' as const]))),
	}));
	await writeFile(join(root, 'runtime', name, `${nonce}.binding`), 'fixture-idle-thread', {
		flag: 'wx',
	});
}
