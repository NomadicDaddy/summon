import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Provider } from '../src/store.ts';

import { cliHarness } from './fixtures/cli-harness.ts';
let fixture: Awaited<ReturnType<typeof cliHarness>>;
let project: string, records: string;
beforeEach(async () => {
	fixture = await cliHarness();
	({ project, records } = fixture);
});
afterEach(async () => {
	await fixture.dispose();
});
const invoke = (...args: Parameters<typeof fixture.invoke>) => fixture.invoke(...args);
const seed = (provider: Provider) => fixture.seed(provider);
const saved = () => fixture.saved();
describe('named CLI sessions', () => {
	test('team names select isolated storage instead of starting a registered agent', async () => {
		await seed('claude');
		const team = await invoke(['--team', 'member']);
		expect(team.code).toBe(0);
		expect(team.launches[0]?.cmd.join(' ')).toContain('dist');
		expect(team.launches[0]?.cmd).toContain(join(fixture.teams, 'team-member'));
		expect(team.launches[0]?.cmd).not.toContain('member');
		expect(team.stdout).toContain('team window ready');
		expect(team.launches[0]?.detached).toBe(true);
		const missing = await invoke(['--team', 'unregistered']);
		expect(missing.code).toBe(0);
		expect(missing.launches[0]?.cmd).toContain(join(fixture.teams, 'team-unregistered'));
	});
	test('team window launch arguments round-trip through the actual bootstrap', async () => {
		const launched = await invoke(['--team', 'argv']);
		expect(launched.code).toBe(0);
		const args = launched.launches[0]?.cmd.slice(2) ?? [];
		expect(args).toHaveLength(5);
		const child = Bun.spawn({
			cmd: [
				process.execPath,
				join(import.meta.dir, 'fixtures/window-storage-argv.ts'),
				...args,
			],
			cwd: project,
			env: {
				...process.env,
				SUMMON_AGENT: '',
				SUMMON_NONCE: '',
				SUMMON_HOME: '',
				SUMMON_TEAMS_HOME: '',
			},
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		});
		const [code, output, error] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(error).toBe('');
		expect(code).toBe(0);
		const selected: unknown = JSON.parse(output);
		expect(selected).toEqual({
			values: [process.execPath, join(import.meta.dir, '../src/cli.ts'), args[4]],
			root: join(fixture.teams, 'team-argv'),
			base: fixture.teams,
		});
	});
	test('team window reports early startup failure instead of success', async () => {
		const result = await invoke(['--team'], { SUMMON_TEST_EXIT: '1' });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Team window did not become ready');
		expect(result.stdout).not.toContain('team window ready');
	});
	test('configured Telegram enables the Claude channel on normal session launches', async () => {
		await seed('claude');
		await mkdir(join(records, 'integrations'));
		await writeFile(
			join(records, 'integrations/telegram.json'),
			JSON.stringify({ botToken: '123:fake', chatId: '456' }),
		);
		for (const args of [
			['member', '--same-window'],
			['__session', 'member'],
		]) {
			const result = await invoke(args);
			expect(result.code).toBe(0);
			expect(result.launches[0]?.cmd).toContain('--dangerously-load-development-channels');
			expect(result.launches[0]?.cmd).toContain('server:summon-mail');
			expect(result.launches[0]?.cmd).not.toContain('--dangerously-skip-permissions');
		}
	});

	test('fresh and resumed Codex launches grant access to the selected registry', async () => {
		const fresh = await invoke(['member', '--using', 'codex', '--same-window']);
		expect(fresh.code).toBe(0);
		await seed('codex');
		const resumed = await invoke(['__session', 'member']);
		expect(resumed.code).toBe(0);
		for (const result of [fresh, resumed]) {
			const command = result.launches[0]?.cmd ?? [];
			expect(command).toContain('--add-dir');
			expect(command[command.indexOf('--add-dir') + 1]).toBe(records);
		}
	});

	test('two Grok names in one directory keep distinct sessions and no foreign transport', async () => {
		const ids: string[] = [];
		for (const name of ['one', 'two']) {
			const result = await invoke([name, '--using', 'grok', '--same-window']);
			expect(result.code).toBe(0);
			const command = result.launches[0]?.cmd ?? [];
			const id = command[2];
			if (!id) throw new Error('Expected a Grok UUID.');
			ids.push(id);
			expect(command.slice(0, 5)).toEqual(['grok', '--session-id', id, '--cwd', project]);
			expect(command).not.toContain('--mcp-config');
			expect(command).not.toContain('--always-approve');
			expect(command).not.toContain('--continue');
			const promptFile = join(records, 'runtime', name, 'session-prompt.md');
			expect(command.at(-1)).toContain(JSON.stringify(promptFile));
			const prompt = await readFile(promptFile, 'utf8');
			expect(prompt).toContain(`summoned as ${name}`);
			expect(prompt).toContain('summon-receive');
		}
		expect(ids[0]).not.toBe(ids[1]);
		const firstId = ids[0];
		if (!firstId) throw new Error('Expected the first Grok UUID.');
		const resumed = await invoke(['one', '--same-window']);
		expect(resumed.launches[0]?.cmd.slice(0, 3)).toEqual(['grok', '--resume', firstId]);
	});

	test('Claude mail opt-in reaches same-window and internal launches without persisting', async () => {
		await seed('claude');
		for (const args of [
			['member', '--same-window', '--claude-mail-channel'],
			['__session', 'member', '--claude-mail-channel'],
		]) {
			const result = await invoke(args);
			expect(result.code).toBe(0);
			const command = result.launches[0]?.cmd ?? [];
			expect(command).toContain('--dangerously-load-development-channels');
			expect(command).toContain('server:summon-mail');
			expect(command).not.toContain('--dangerously-skip-permissions');
			expect(command).not.toContain('--channels');
		}
		const ordinary = await invoke(['member', '--same-window']);
		expect(ordinary.launches[0]?.cmd).not.toContain('--dangerously-load-development-channels');
		expect(ordinary.launches[0]?.cmd).not.toContain('--channels');
		expect(await saved()).not.toHaveProperty('claudeMailChannel');
	});

	test('Codex launch hooks this package without a PATH summon command', async () => {
		await seed('codex');
		const result = await invoke(['member', '--same-window']);
		const config = result.launches[0]?.cmd.find((arg) => arg.startsWith('hooks.SessionStart='));
		expect(config).toContain('cli.ts');
		expect(config).toContain('__mail-bind');
		expect(config).toContain('command_windows');
		expect(config).toContain('startup|resume|clear');
		expect(config).not.toContain('summon __mail-bind');
	});

	test('new terminals carry the explicit Claude mail opt-in', async () => {
		await seed('claude');
		const result = await invoke(['member', '--claude-mail-channel']);
		expect(result.code).toBe(0);
		expect(JSON.stringify(result.launches)).toContain('--claude-mail-channel');
	});

	test.each(['codex', 'grok'] as const)(
		'%s rejects Claude mail opt-in before changing records or launching',
		async (provider) => {
			const original = await seed(provider);
			for (const args of [
				['member', '--claude-mail-channel', '--note', 'Must not save'],
				['__session', 'member', '--claude-mail-channel'],
				['new-provider', '--using', provider, '--claude-mail-channel'],
			]) {
				const result = await invoke(args);
				expect(result.code).toBe(1);
				expect(result.stderr).toContain('requires a Claude agent');
				expect(result.launches).toEqual([]);
			}
			expect(await saved()).toEqual(original);
			expect(await readdir(records)).not.toContain('new-provider.json');
			expect(await readFile(join(records, 'member.md'), 'utf8')).not.toContain(
				'Must not save',
			);
		},
	);
});
