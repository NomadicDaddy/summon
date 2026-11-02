import { installGrokTurnHooks } from '../../src/grok-turn-hooks.ts';
import { acquireSessionLock } from '../../src/session-lock.ts';

const home = process.argv[2];
if (!home) throw new Error('Disposable Grok home required.');
const lock = await acquireSessionLock('alpha');
if (!lock) throw new Error('Test owner could not acquire its session.');
const cleanup = await installGrokTurnHooks('alpha', 'previous-launch', 'old-thread', home);
try {
	if (process.argv[3]) await lock.setChild(Number(process.argv[3]));
	console.log('HOOK_READY');
	await Bun.sleep(60000);
} finally {
	await cleanup();
	await lock.release();
}
