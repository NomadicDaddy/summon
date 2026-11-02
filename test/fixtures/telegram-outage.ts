import { randomUUID } from 'node:crypto';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TRANSIENT_FAILURE_GRACE_MS } from '../../src/telegram-health.ts';

/**
 * Records an unannounced Telegram outage that opened before the grace period, as if refreshes had
 * been failing for over a minute. The next failed refresh then announces it at once, which is what
 * a test of the operator's failure notice, recovery notice or outage package needs. A single
 * transient failure alone stays quiet (#14147). The fixture bot token is 123:..., so its state
 * folder is integrations/telegram-state/123 under the harness root.
 */
export async function persistedOutage(
	root: string,
	reason = 'The Telegram request timed out.',
): Promise<void> {
	const folder = join(root, 'integrations', 'telegram-state', '123');
	await mkdir(folder, { recursive: true });
	const path = join(folder, 'health.json');
	await writeFile(path, JSON.stringify({ id: randomUUID(), reason, announced: false }));
	const opened = new Date(Date.now() - 2 * TRANSIENT_FAILURE_GRACE_MS);
	await utimes(path, opened, opened);
}
