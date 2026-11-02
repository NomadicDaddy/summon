import type { IPtyForkOptions } from 'node-pty';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Team, type TerminalProcess } from '../src/desktop/team.ts';
import { grokTurnHooks } from '../src/grok-turn-hooks.ts';
import { loadAgent, saveAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = {
	SUMMON_HOME: process.env.SUMMON_HOME,
	SUMMON_TEAMS_HOME: process.env.SUMMON_TEAMS_HOME,
};
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	delete process.env.SUMMON_TEAMS_HOME;
	await mkdir(join(fixture.records, 'settings'));
	await writeFile(
		join(fixture.records, 'settings/claude-delivery.json'),
		'{"version":1,"mode":"checkpoint"}',
	);
});
afterEach(async () => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = value;
	}
	await fixture.dispose();
});

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const) {
	test(`${provider} window launch carries the selected root and base independently of cwd`, async () => {
		const record = await loadAgent('alpha');
		if (!record) throw new Error('Missing fixture registration');
		record.provider = provider;
		await saveAgent('alpha', record);
		const captures: { args: string[]; options: IPtyForkOptions }[] = [];
		let exited: (event: { exitCode: number }) => void = () => {};
		const pty: TerminalProcess = {
			pid: 1,
			onData: () => ({ dispose: () => {} }),
			onExit: (callback) => {
				exited = callback;
				return { dispose: () => {} };
			},
			write: () => {},
			resize: () => {},
			kill: () => {
				exited({ exitCode: 0 });
			},
		};
		const team = new Team(
			'bun',
			'cli.ts',
			() => {},
			(_file, args, options) => {
				captures.push({ args, options });
				return pty;
			},
			() => {
				pty.kill();
				return Promise.resolve();
			},
		);
		try {
			await team.start('alpha');
			const first = captures[0];
			expect(first?.options.cwd).toBe(fixture.root);
			expect(first?.options.env?.SUMMON_HOME).toBe(fixture.records);
			expect(first?.options.env?.SUMMON_TEAMS_HOME).toBeUndefined();
			if (provider === 'grok') {
				const hook = grokTurnHooks('alpha', 'launch', 'native').hooks.Notification[0]
					?.hooks[0];
				expect(hook?.env.SUMMON_TEAMS_HOME).toBeUndefined();
			}
			expect(first?.args.slice(0, 7)).toEqual([
				'cli.ts',
				'__session',
				'alpha',
				'--storage-root',
				fixture.records,
				'--teams-base',
				'--standalone-store',
			]);
			await team.stop('alpha');
			const base = join(fixture.root, 'explicit teams base');
			process.env.SUMMON_TEAMS_HOME = base;
			await team.start('alpha');
			const second = captures[1];
			expect(second?.options.env?.SUMMON_TEAMS_HOME).toBe(base);
			expect(second?.args[6]).toBe(base);
			expect(second?.options.env?.SUMMON_HOME).toBe(fixture.records);
			if (provider === 'grok') {
				const hook = grokTurnHooks('alpha', 'launch', 'native').hooks.Notification[0]
					?.hooks[0];
				expect(hook?.env.SUMMON_HOME).toBe(fixture.records);
				expect(hook?.env.SUMMON_TEAMS_HOME).toBe(base);
			}
		} finally {
			await team.shutdown();
		}
	});
}
