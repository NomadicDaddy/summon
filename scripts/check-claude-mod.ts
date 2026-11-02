import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { claudeTurnModule } from '../src/claude-turn-module.ts';
import { executableCommand, requireExecutable } from '../src/executable.ts';
import { atomicWrite } from '../src/mail-files.ts';

/** Installed engine fixtures only: no plugin install, provider session or model inference. */
const root = await mkdtemp(join(tmpdir(), 'summon-claude-mod-'));
if (
	dirname(resolve(root)) !== resolve(tmpdir()) ||
	!basename(root).startsWith('summon-claude-mod-')
)
	throw new Error('Unexpected disposable fixture path; cleanup refused.');
try {
	await atomicWrite(
		join(root, '.claude-plugin/plugin.json'),
		JSON.stringify({
			name: 'summon-native-turn-contract',
			version: '0.0.1',
			author: { name: 'Summon' },
			description:
				'Disposable offline generated-module verification; never install or activate',
		}),
	);
	await atomicWrite(
		join(root, 'hooks/hooks.json'),
		JSON.stringify({ modules: ['./register.js'] }),
	);
	await atomicWrite(join(root, 'hooks/register.js'), claudeTurnModule);
	await atomicWrite(
		join(root, 'native.test.ts'),
		await Bun.file(
			join(import.meta.dir, '../test/fixtures/claude-native-contract.fixture'),
		).text(),
	);
	const executable = requireExecutable('claude');
	for (const args of [
		['plugin', 'validate', '--strict', root],
		['plugin', 'test', root],
	]) {
		const child = Bun.spawn({
			cmd: executableCommand([executable, ...args]),
			stdin: 'ignore',
			stdout: 'inherit',
			stderr: 'inherit',
			windowsHide: true,
		});
		if ((await child.exited) !== 0)
			throw new Error('Installed Claude mod contract check failed.');
	}
} finally {
	await rm(root, { recursive: true, force: true });
}
