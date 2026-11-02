import { resolve } from 'node:path';

import { requireExecutable } from '../src/executable.ts';
import { missing } from '../src/mail-files.ts';

const root = resolve(import.meta.dir, '..');
const child = Bun.spawn(
	[
		requireExecutable('git'),
		'ls-files',
		'--cached',
		'--others',
		'--exclude-standard',
		'-z',
		'--',
		'*.ts',
	],
	{
		cwd: root,
		stdout: 'pipe',
		stderr: 'inherit',
		windowsHide: true,
	},
);
const output = await new Response(child.stdout).text();
if ((await child.exited) !== 0) throw new Error('Could not enumerate TypeScript files.');
const failures: string[] = [];
for (const path of new Set(output.split('\0').filter(Boolean))) {
	let text: string;
	try {
		text = await Bun.file(resolve(root, path)).text();
	} catch (error: unknown) {
		if (missing(error)) continue;
		throw error;
	}
	const count = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
	if (count > 300) failures.push(`${path}: ${count} lines (maximum 300)`);
}
if (failures.length) {
	console.error(failures.join('\n'));
	process.exitCode = 1;
} else console.log('TypeScript files are within the 300-line limit.');
