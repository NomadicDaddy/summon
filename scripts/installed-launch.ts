import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runtimePrerequisites, runtimeVersionStatus } from '../src/runtime-prerequisites.ts';

const status = runtimeVersionStatus('bun', Bun.version);
if (status.status !== 'available') {
	console.error(`Summon cannot start: ${status.detail}.`);
	console.error(`Install Bun from ${runtimePrerequisites[0]?.installUrl}`);
	// A terminal opened before setup keeps its old PATH, and with it an older Bun (Morgan r4 High).
	console.error(
		'If a newer Bun is already installed, open a new terminal or start Summon from Start so it uses the updated PATH.',
	);
	process.exit(1);
}
// Keep CLI argument and relative-entry semantics identical to a direct source launch.
process.argv[1] = resolve(import.meta.dir, '../src/cli.ts');
await import(pathToFileURL(process.argv[1]).href);
