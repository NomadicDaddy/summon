import { afterEach, expect, test } from 'bun:test';
import { platform } from 'node:os';
import { resolve } from 'node:path';

import { selectedTeamsBase, standaloneBaseArgument } from '../src/storage-root.ts';
import { terminalCommand } from '../src/terminal.ts';

const previous = process.env.SUMMON_HOME;
test('missing launchers return the same-window fallback signal', () => {
	const path = process.env.PATH;
	process.env.PATH = '';
	try {
		expect(terminalCommand('cli.ts', 'test-agent', 'claude', process.cwd())).toBeUndefined();
	} finally {
		if (path === undefined) delete process.env.PATH;
		else process.env.PATH = path;
	}
});
afterEach(() => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
});

test.skipIf(platform() !== 'win32')(
	'different registries get distinct team windows and carry their root',
	() => {
		process.env.SUMMON_HOME = resolve('test registry one');
		const first = terminalCommand('cli.ts', 'test-agent', 'claude', process.cwd(), true);
		expect(first?.slice(-7)).toEqual([
			'__session',
			'test-agent',
			'--storage-root',
			process.env.SUMMON_HOME,
			'--teams-base',
			selectedTeamsBase() ?? standaloneBaseArgument,
			'--claude-mail-channel',
		]);
		process.env.SUMMON_HOME = resolve('test registry two');
		const second = terminalCommand('cli.ts', 'test-agent', 'claude', process.cwd());
		expect(first?.[2]).not.toBe(second?.[2]);
	},
);
