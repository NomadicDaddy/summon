import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readMacros, saveMacros } from '../src/team-macros.ts';

test('ten macro slots persist text and optional Enter, rejecting malformed changes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-macros-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		const defaults = await readMacros();
		expect(defaults).toHaveLength(10);
		expect(defaults.filter((macro) => macro.text)).toHaveLength(2);
		expect(defaults.every((macro) => !macro.send)).toBe(true);
		defaults[3] = { text: 'First line\nSecond line', send: true };
		defaults[2] = { text: '/summon-next (your domain only)', send: false };
		await saveMacros(defaults);
		const path = join(root, 'runtime', 'team-window', 'macros.json');
		const saved = await readFile(path, 'utf8');
		expect(await readMacros()).toEqual(defaults);
		expect(await readFile(path, 'utf8')).toBe(saved);
		const wrongCount: unknown = await saveMacros([]).catch((error: unknown) => error);
		expect(wrongCount).toBeInstanceOf(Error);
		const incomplete: unknown = await saveMacros(
			defaults.map((value, index) =>
				index === 3 ? { ...value, text: 'x'.repeat(4097) } : value,
			),
		).catch((error: unknown) => error);
		expect(incomplete).toBeInstanceOf(Error);
		expect(await readMacros()).toEqual(defaults);
		await writeFile(
			path,
			JSON.stringify(defaults.map((value) => ({ label: 'Old label', ...value }))),
		);
		expect(await readMacros()).toEqual(defaults);
		expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(defaults);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
});
