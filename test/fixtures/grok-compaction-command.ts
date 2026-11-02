import assert from 'node:assert/strict';

import { readCompactions } from '../../src/compaction-history.ts';
import { grokTurnHooks, installGrokTurnHooks } from '../../src/grok-turn-hooks.ts';
import { acquireSessionLock } from '../../src/session-lock.ts';

const [root, timestamp] = process.argv.slice(2);
if (!root || !timestamp || !process.env.SUMMON_HOME)
	throw new Error('Missing isolated Grok command fixture arguments.');

const sessionLock = await acquireSessionLock('alpha');
if (!sessionLock) throw new Error('Missing test session lock.');
let cleanup: (() => Promise<void>) | undefined;
try {
	cleanup = await installGrokTurnHooks('alpha', 'compact-command', 'native-thread', root);
	for (const kind of ['PreCompact', 'PostCompact'] as const) {
		const hook = grokTurnHooks('alpha', 'compact-command', 'native-thread').hooks[kind][0]
			?.hooks[0];
		if (!hook) throw new Error('Missing hook command.');
		const child: Bun.Subprocess<Uint8Array<ArrayBuffer>, 'pipe', 'pipe'> = Bun.spawn(
			process.platform === 'win32'
				? ['pwsh', '-NoProfile', '-NonInteractive', '-Command', hook.command]
				: ['sh', '-c', hook.command],
			{
				env: { ...process.env, ...hook.env, GROK_SESSION_ID: 'native-thread' },
				stdin: new TextEncoder().encode(
					JSON.stringify({
						hook_event_name: kind,
						sessionId: 'native-thread',
						timestamp,
						privateContext: 'PRIVATE_MUST_NOT_PERSIST',
					}),
				),
				stdout: 'pipe',
				stderr: 'pipe',
				windowsHide: true,
			},
		);
		const [exit, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		assert.deepEqual({ exit, stdout, stderr }, { exit: 0, stdout: '', stderr: '' });
	}
	console.log(JSON.stringify(await readCompactions('alpha', 10)));
} finally {
	await cleanup?.();
	await sessionLock.release();
}
