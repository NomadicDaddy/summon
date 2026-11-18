import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { atomicWrite, locked, optionalText } from '../src/mail-files.ts';
import { operatorOnly } from '../src/mail-identity.ts';
import { assertOfflineProcesses } from '../src/offline-processes.ts';
import { scheduleStateV1ToV2, scheduleStateV2ToV1 } from '../src/schedule-state-migration.ts';
import { storageRoot } from '../src/store.ts';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

operatorOnly();
const args = process.argv.slice(2);
const mode = args[1] ?? '';
if (
	args.length !== 2 ||
	args[0] !== '--offline' ||
	!['--apply', '--preflight', '--rollback'].includes(mode)
)
	throw new Error(
		'Usage: bun scripts/migrate-schedule-state.ts --offline --preflight|--apply|--rollback. Close ALL Summon windows, sessions and receivers first.',
	);
await assertOfflineProcesses();
const path = join(storageRoot(), 'schedules', 'state.json');
await locked(`${path}.lock`, async () => {
	const before = await optionalText(path);
	if (before === undefined) throw new Error('No schedule state to migrate.');
	const rollback = mode === '--rollback';
	const after = rollback ? scheduleStateV2ToV1(before) : scheduleStateV1ToV2(before);
	const summary = {
		mode,
		beforeBytes: Buffer.byteLength(before),
		beforeSha256: sha256(before),
		afterBytes: Buffer.byteLength(after),
		afterSha256: sha256(after),
	};
	if (mode === '--preflight') {
		console.log(JSON.stringify({ ready: true, ...summary }));
		return;
	}
	await assertOfflineProcesses();
	// The sealed copy is never deleted by Summon; the operator decides when it may go.
	const backup = join(storageRoot(), 'runtime', 'schedule-migrations', randomUUID());
	await atomicWrite(join(backup, 'state.json'), before);
	if ((await optionalText(join(backup, 'state.json'))) !== before)
		throw new Error('The sealed copy did not read back; migration refused.');
	await atomicWrite(path, after);
	const live = await optionalText(path);
	if (live !== after || (!rollback && scheduleStateV2ToV1(live) !== before)) {
		await atomicWrite(path, before);
		throw new Error(
			`Read-back check failed; the original was restored. Sealed copy: ${backup}`,
		);
	}
	await atomicWrite(join(backup, 'complete.json'), JSON.stringify(summary));
	console.log(JSON.stringify({ migrated: true, backup, ...summary }));
});
