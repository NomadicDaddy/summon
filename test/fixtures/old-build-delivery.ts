import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('Pinned tree is required');
const source = (name: string) => pathToFileURL(join(root, 'src', name)).href;
const { initializeActivity } = (await import(
	source('agent-activity.ts')
)) as typeof import('../../src/agent-activity.ts');
const { retainWakeError, recoverWakeError, wakeErrors } = (await import(
	source('wake-errors.ts')
)) as typeof import('../../src/wake-errors.ts');
const { startMailWatcher } = (await import(
	source('mail-watcher.ts')
)) as typeof import('../../src/mail-watcher.ts');
const { markReady } = (await import(
	source('mail-session.ts')
)) as typeof import('../../src/mail-session.ts');
const { sendMessage } = (await import(
	source('mailbox.ts')
)) as typeof import('../../src/mailbox.ts');

// All imports above resolve to the exact old tree. Only disposable fixture state is used.
const nonce = 'rollback-fresh-launch';
process.env.SUMMON_NONCE = nonce;
await initializeActivity('alpha', nonce);
await retainWakeError('alpha', 'pending wake', new Error('fixture'));
await recoverWakeError('alpha', 'pending wake');
if (!(await wakeErrors('alpha')).find((entry) => entry.stage === 'pending wake')?.recoveredAt)
	throw new Error('Old-build ordinary recovery did not complete');
const notices: string[] = [];
const stop = await startMailWatcher('alpha', nonce, (text) => {
	notices.push(text);
	return Promise.resolve();
});
const waitFor = async (text: string) => {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (notices.some((notice) => notice.includes(text))) return;
		await Bun.sleep(10);
	}
	throw new Error('Old-build notification did not arrive');
};
try {
	await waitFor('--mail ready');
	await markReady('alpha', nonce);
	await sendMessage('alpha', 'alpha', 'rollback fixture');
	await waitFor('1 new mailbox event');
	console.log('OLD_BUILD_RECOVERY_AND_DELIVERY_OK');
} finally {
	await stop();
}
