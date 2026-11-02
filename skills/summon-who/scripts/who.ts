import { homedir } from 'node:os';

import { presenceRows } from '../../../src/presence-command.ts';
import { storageRoot } from '../../../src/store.ts';

// The same resolver as `summon --presence` and the Team Window's view of sessions it does not own.
const rows = await presenceRows();
if (rows.length === 0) console.log(`No registered agents in ${storageRoot() || homedir()}.`);
for (const row of rows) {
	const status = row.hibernated ? 'hibernated' : row.state;
	const detail = row.hibernated ? `${row.state}; ${row.reason}` : row.reason;
	console.log(`${row.name}\t${row.provider}\t${status}\t${detail}`);
}
