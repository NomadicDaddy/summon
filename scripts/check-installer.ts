import { join, resolve } from 'node:path';

import { checkInstallerNative } from './check-installer-native.ts';
import { checkInstallerPayload } from './installer-payload.ts';
import { installerProbe } from './installer-probe.ts';

if (!process.argv[2]) throw new Error('Provide the installer payload directory.');
const payload = resolve(process.argv[2]);
const count = await checkInstallerPayload(payload);
const { root, environment, probe } = await installerProbe(payload);
await probe(
	[
		process.execPath,
		'-e',
		`if (process.env.PATH !== ${JSON.stringify(environment.PATH)}) throw new Error('Bun PATH isolation failed'); console.log('system-only-path');`,
	],
	'system-only-path',
);
await probe(
	[process.execPath, join(payload, 'app/scripts/installed-launch.ts'), '--help'],
	'summon <name>',
);
if (
	!(await Bun.file(join(root, 'store/team-default/AGENTS.md')).exists()) ||
	(await Bun.file(join(root, 'store/AGENTS.md')).exists())
)
	throw new Error('Installed CLI did not initialize the selected default-team subfolder.');
await checkInstallerNative(payload);
console.log(
	`Verified ${count} payload hashes, external prerequisite metadata, required Electron/library assets, isolated external-Bun CLI/default-team and Electron/node-pty checks. No installed-host or provider acceptance was performed.`,
);
