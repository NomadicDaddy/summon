import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { installerProbe } from './installer-probe.ts';

export async function checkInstallerNative(payload: string): Promise<void> {
	const { root, environment, probe } = await installerProbe(payload);
	const nativeProbe = join(root, 'native-probe.cjs');
	await writeFile(
		nativeProbe,
		`
const { createRequire } = require('node:module');
if (process.env.PATH !== ${JSON.stringify(environment.PATH)}) throw new Error('Electron PATH isolation failed');
const load = createRequire(${JSON.stringify(join(payload, 'app/package.json'))});
const pty = load('node-pty').spawn(${JSON.stringify(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/cmd.exe'))}, ['/d', '/c', 'echo summon-native-ready'], {
  name: 'xterm-color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
});
let output = '';
pty.onData(data => { output += data; });
pty.onExit(({ exitCode }) => {
  console.log(output);
  process.exit(exitCode === 0 && output.includes('summon-native-ready') ? 0 : 1);
});
setTimeout(() => { pty.kill(); process.exit(1); }, 10000).unref();
`,
	);
	await probe(
		[
			process.execPath,
			'-e',
			`
const child = Bun.spawn([${JSON.stringify(join(payload, 'app/node_modules/electron/dist/electron.exe'))}, ${JSON.stringify(nativeProbe)}], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true,
  stdout: 'inherit', stderr: 'inherit', stdin: 'ignore',
}); process.exit(await child.exited);
`,
		],
		'summon-native-ready',
	);
	console.log(
		'Explicit native payload Electron/node-pty check passed; not installed-host acceptance.',
	);
}
