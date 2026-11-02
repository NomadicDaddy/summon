import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';

import { type Provider, providers as registeredProviders } from '../src/store.ts';
import { cliHarness } from './fixtures/cli-harness.ts';
let fixture: Awaited<ReturnType<typeof cliHarness>>;
const providers = [...registeredProviders];
let root: string, project: string, records: string;
beforeEach(async () => {
	fixture = await cliHarness();
	({ root, project, records } = fixture);
});
afterEach(async () => {
	await fixture.dispose();
});
const invoke = (...args: Parameters<typeof fixture.invoke>) => fixture.invoke(...args);
const seed = (provider: Provider) => fixture.seed(provider);
const saved = () => fixture.saved();
describe('named CLI sessions', () => {
	test.each(providers)(
		'large %s startup notes stay out of the process command line',
		async (provider) => {
			const record = await seed(provider);
			const notes = `START ${'Long handoff with unicode Ω. '.repeat(400)} END`;
			expect(Buffer.byteLength(notes)).toBeGreaterThan(8192);
			expect(Buffer.byteLength(notes)).toBeLessThanOrEqual(16 * 1024);
			record.expertise = notes;
			await writeFile(join(records, 'member.json'), JSON.stringify(record));
			await writeFile(join(records, 'member.md'), notes);
			const result = await invoke(['member', '--same-window']);
			expect(result.code).toBe(0);
			expect(result.launches).toHaveLength(1);
			const command = result.launches[0]?.cmd ?? [];
			expect(command.join(' ').length).toBeLessThan(10000);
			expect(command.join(' ')).not.toContain('Long handoff');
			const file = provider === 'kilo' ? 'kilo-instructions.md' : 'session-prompt.md';
			expect(await readFile(join(records, 'runtime', 'member', file), 'utf8')).toContain(
				notes,
			);
			await writeFile(join(records, 'member.md'), 'Replacement handoff');
			record.expertise = 'Short expertise';
			await writeFile(join(records, 'member.json'), JSON.stringify(record));
			expect((await invoke(['member', '--same-window'])).code).toBe(0);
			const refreshed = await readFile(join(records, 'runtime', 'member', file), 'utf8');
			expect(refreshed).toContain('Replacement handoff');
			expect(refreshed).not.toContain('Long handoff');
		},
	);
	test.each(providers)('plain names resume their registered %s CLI', async (provider) => {
		const original = await seed(provider);
		const result = await invoke(['member', '--same-window']);
		expect(await readFile(join(records, 'AGENTS.md'), 'utf8')).toBe(
			await readFile(resolve(import.meta.dir, '../templates/AGENTS.md.template'), 'utf8'),
		);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe('');
		expect(result.launches).toHaveLength(1);
		const launch = result.launches[0];
		if (provider === 'codex') {
			const history = join(records, 'compactions', 'member');
			const files = await readdir(history);
			expect(files).toHaveLength(1);
			const metadata: unknown = JSON.parse(
				await readFile(join(history, files[0] ?? ''), 'utf8'),
			);
			expect(metadata).toMatchObject({
				provider: 'codex',
				source: 'codex-rollout',
				phase: 'recorded',
			});
			expect(JSON.stringify(metadata)).not.toContain('existing-session');
		}
		expect(launch?.cmd.slice(0, 2)).toEqual([
			provider,
			provider === 'kilo' ? project : provider === 'codex' ? 'resume' : '--resume',
		]);
		expect(launch?.cmd).toContain('existing-session');
		if (provider === 'kilo') {
			// Kilo is handed no prompt argument: it arrives through the instructions file that
			// kiloInstructions registers. The coverage moves with it rather than being dropped.
			const instructions = await readFile(
				join(records, 'runtime', 'member', 'kilo-instructions.md'),
				'utf8',
			);
			expect(instructions).toContain(original.expertise);
			expect(instructions).toContain('A note from an earlier session.');
			expect(launch?.cmd).toContain('--port');
			expect(launch?.cmd).not.toContain('--prompt');
		} else {
			const path = join(records, 'runtime', 'member', 'session-prompt.md');
			const instructions = await readFile(path, 'utf8');
			expect(launch?.cmd.at(-1)).toContain(JSON.stringify(path));
			expect(instructions).toContain(original.expertise);
			expect(instructions).toContain('A note from an earlier session.');
		}
		expect(launch?.cwd).toBe(project);
		const record = await saved();
		expect(record.provider).toBe(provider);
		expect(record.expertise).toBe(original.expertise);
		expect(record.createdAt).toBe(original.createdAt);
		expect(record.sessions).toHaveLength(1);
		expect(record.sessions[0]?.createdAt).toBe(original.sessions[0]?.createdAt);
	});

	test.each(providers)('new names save %s and reuse it without --using', async (provider) => {
		const choice = provider === 'claude' ? [] : ['--using', provider];
		const first = await invoke([
			'member',
			...choice,
			'--same-window',
			'--note',
			'New context.',
		]);
		expect(first.code).toBe(0);
		expect(first.launches[0]?.cmd[0]).toBe(provider);
		expect(first.launches[0]?.cmd).not.toContain('--resume');
		expect(first.launches[0]?.cmd).not.toContain('resume');
		const record = await saved();
		expect(record.version).toBe(3);
		expect(record.provider).toBe(provider);
		expect(await readFile(join(records, 'member.md'), 'utf8')).toBe('New context.\n');
		expect(record.sessions).toHaveLength(1);
		const id = record.sessions[0]?.id;
		if (!id) throw new Error('Expected a saved session ID.');
		if (provider === 'codex') expect(id).toBe('test-codex-session');
		else if (provider === 'kilo')
			expect(first.launches[0]?.cmd.slice(0, 4)).toEqual([
				provider,
				project,
				'--session',
				id,
			]);
		else expect(first.launches[0]?.cmd.slice(0, 3)).toEqual([provider, '--session-id', id]);

		const second = await invoke(['member', '--same-window']);
		expect(second.code).toBe(0);
		expect(second.launches[0]?.cmd[0]).toBe(provider);
		expect(second.launches[0]?.cmd).toContain(id);
		expect(second.launches[0]?.cmd[1]).toBe(
			provider === 'kilo' ? project : provider === 'codex' ? 'resume' : '--resume',
		);
		expect((await saved()).sessions).toHaveLength(1);
	});

	test.each(providers)('matching --using is accepted for %s', async (provider) => {
		await seed(provider);
		const result = await invoke(['member', '--using', provider, '--same-window']);
		expect(result.code).toBe(0);
		expect(result.launches[0]?.cmd[0]).toBe(provider);
	});

	test.each(providers)('conflicting --using cannot change a %s record', async (provider) => {
		await seed(provider);
		const before = await readFile(join(records, 'member.json'), 'utf8');
		const other = provider === 'codex' ? 'claude' : 'codex';
		const result = await invoke([
			'member',
			'--using',
			other,
			'--note',
			'Must not be appended.',
			'--cwd',
			root,
			'--same-window',
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('registered with ' + provider);
		expect(result.launches).toEqual([]);
		expect(await readFile(join(records, 'member.json'), 'utf8')).toBe(before);
	});

	test.each(providers)(
		'new-terminal launches for %s pass only the registered name',
		async (provider) => {
			await seed(provider);
			const result = await invoke(['member']);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain('Summoned Member with ' + provider);
			expect(result.launches).toHaveLength(1);
			const cmd = result.launches[0]?.cmd;
			if (!cmd) throw new Error('Expected a terminal command.');
			expect(cmd[0]).not.toBe(provider);
			if (platform() === 'win32') {
				expect(cmd[0]).toBe('wt.exe');
				expect(cmd.slice(-6)).toEqual([
					'__session',
					'member',
					'--storage-root',
					records,
					'--teams-base',
					fixture.teams,
				]);
				expect(cmd[2]).toStartWith('summon-');
				expect(cmd).toContain('--suppressApplicationTitle');
				expect(cmd).toContain(project);
			} else {
				expect(cmd.join(' ')).toContain("'__session' 'member'");
				expect(cmd.join(' ')).not.toContain("'__session' 'member' '" + provider + "'");
			}
		},
	);

	test.each(providers)('the internal runner loads the saved %s CLI', async (provider) => {
		await seed(provider);
		const result = await invoke(['__session', 'Member']);
		expect(result.code).toBe(0);
		expect(result.launches[0]?.cmd[0]).toBe(provider);
	});

	test('a terminal runner uses its explicit registry instead of an inherited window environment', async () => {
		await seed('claude');
		const result = await invoke(['__session', 'member', '--storage-root', records], {
			SUMMON_HOME: join(root, 'other-registry'),
		});
		expect(result.code).toBe(0);
		expect(result.launches[0]?.cmd[0]).toBe('claude');
		expect(result.launches[0]?.cmd).toContain('existing-session');
	});

	test('the internal runner rejects provider overrides and paths', async () => {
		await seed('codex');
		const before = await readFile(join(records, 'member.json'), 'utf8');
		for (const args of [
			['__session', 'member', 'claude'],
			['__session', '../member'],
		]) {
			const result = await invoke(args);
			expect(result.code).toBe(1);
			expect(result.launches).toEqual([]);
		}
		expect(await readFile(join(records, 'member.json'), 'utf8')).toBe(before);
	});

	test('invalid provider choices fail before registration', async () => {
		for (const args of [
			['member', '--using'],
			['member', '--using', 'unknown'],
		]) {
			const result = await invoke(args);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('--using must be claude, codex, grok, or kilo');
			expect(result.launches).toEqual([]);
			expect(await readdir(records)).toEqual(['AGENTS.md']);
		}
	});

	test('invalid records are not rewritten or launched', async () => {
		const original = await seed('codex');
		const invalid = JSON.stringify({ ...original, provider: 'unknown' });
		await writeFile(join(records, 'member.json'), invalid);
		const result = await invoke(['member', '--same-window']);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Invalid agent record');
		expect(result.launches).toEqual([]);
		expect(await readFile(join(records, 'member.json'), 'utf8')).toBe(invalid);
	});

	test('provider exit codes are preserved', async () => {
		await seed('codex');
		const result = await invoke(['member', '--same-window'], { SUMMON_TEST_EXIT: '17' });
		expect(result.code).toBe(17);
		expect((await saved()).provider).toBe('codex');
	});

	test.each(['claude', 'grok', 'kilo'] as const)(
		'a failed first %s launch removes the unstarted session, not its registration',
		async (provider) => {
			const result = await invoke(['member', '--using', provider, '--same-window'], {
				SUMMON_TEST_SPAWN_ERROR: '1',
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('Simulated launch failure');
			const record = await saved();
			expect(record.provider).toBe(provider);
			expect(record.sessions).toEqual([]);
		},
	);
});
