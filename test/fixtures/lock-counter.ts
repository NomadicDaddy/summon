import { readFile, writeFile } from 'node:fs/promises';

import { locked } from '../../src/mail-files.ts';

const [path, count] = process.argv.slice(2);
if (!path || count !== '40') throw new Error('Expected isolated counter and 40 cycles.');
for (let index = 0; index < 40; index++) {
	await locked(`${path}.lock`, async () => {
		const value = Number(await readFile(path, 'utf8'));
		await writeFile(path, String(value + 1));
	});
}
