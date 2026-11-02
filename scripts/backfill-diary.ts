import { assertBackfillWindowOffline } from '../src/diary-backfill-window.ts';
import { applyDiaryBackfill, preflightDiaryBackfill } from '../src/diary-backfill.ts';
import { operatorOnly } from '../src/mail-identity.ts';
import { messageBodyArgs } from '../src/message-body-file.ts';
import { storageRoot } from '../src/store.ts';

const [mode, path, extra] = process.argv.slice(2);
if (!path || extra !== undefined || (mode !== '--preflight' && mode !== '--apply'))
	throw new Error('Usage: bun scripts/backfill-diary.ts --preflight|--apply <UTF-8-plan.json>');
if (mode === '--apply') operatorOnly();
const body = (await messageBodyArgs(['--body-file', path], 0))[0];
if (!body || Buffer.byteLength(body) > 1024 * 1024)
	throw new Error('Backfill plan exceeds one MiB.');
const plan: unknown = JSON.parse(body);
if (mode === '--preflight') console.log(JSON.stringify(await preflightDiaryBackfill(plan)));
else {
	await assertBackfillWindowOffline(storageRoot());
	console.log(JSON.stringify(await applyDiaryBackfill(plan)));
}
