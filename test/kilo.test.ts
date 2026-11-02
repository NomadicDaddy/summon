import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { kiloAgentVariant, kiloEnvironment, validKiloOptions } from '../src/kilo-config.ts';
import { createKiloSession } from '../src/kilo-session.ts';
import { cliHarness } from './fixtures/cli-harness.ts';

test.each([false, true])(
	'Kilo opens an owned startup API on launch (resume=%s)',
	async (resume) => {
		const fixture = await cliHarness();
		try {
			const record = await fixture.seed('kilo');
			if (!resume) {
				record.sessions = [];
				await writeFile(join(fixture.records, 'member.json'), JSON.stringify(record));
			}
			const result = await fixture.invoke(['member', '--same-window']);
			expect(result.code).toBe(0);
			const command = result.launches.find((launch) => launch.cmd.includes('--session'))?.cmd;
			expect(command).toBeDefined();
			const index = command?.indexOf('--port') ?? -1;
			expect(index).toBeGreaterThan(0);
			expect(Number(command?.[index + 1])).toBeGreaterThan(0);
			expect(command).toContain('127.0.0.1');
			expect(command).not.toContain('--prompt');
			expect(command).not.toContain('--auto');
			const instructions = await readFile(
				join(fixture.records, 'runtime/member/kilo-instructions.md'),
				'utf8',
			);
			expect(instructions).toContain(record.expertise);
			expect((await fixture.saved()).sessions).toHaveLength(1);
		} finally {
			await fixture.dispose();
		}
	},
);

test('Kilo configuration validates model/endpoint and preserves unrelated provider settings', () => {
	expect(validKiloOptions('kilo', 'lmstudio/model', 'http://127.0.0.1:1234/v1')).toBe(true);
	for (const url of ['file:///tmp', 'http://user:pass@localhost/v1', 'http://localhost/?key=x'])
		expect(validKiloOptions('kilo', 'lmstudio/model', url)).toBe(false);
	expect(validKiloOptions('codex', 'lmstudio/model')).toBe(false);
	expect(validKiloOptions('kilo', '--oops')).toBe(false);
	expect(validKiloOptions('kilo', 'cloud/model', 'http://localhost/v1')).toBe(false);
	const previous = process.env.KILO_CONFIG_CONTENT;
	try {
		process.env.KILO_CONFIG_CONTENT = JSON.stringify({
			permission: 'ask',
			provider: {
				other: { name: 'Keep' },
				lmstudio: { options: { timeout: 1000 }, models: { old: { name: 'Old' } } },
			},
		});
		const config = JSON.parse(kiloEnvironment('lmstudio/new').KILO_CONFIG_CONTENT ?? '{}') as {
			permission: string;
			provider: {
				other: { name: string };
				lmstudio: { options: { timeout: number; baseURL: string }; models: object };
			};
		};
		expect(config.permission).toBe('ask');
		expect(config.provider.other.name).toBe('Keep');
		expect(config.provider.lmstudio.options).toEqual({
			timeout: 1000,
			baseURL: 'http://127.0.0.1:1234/v1',
		});
		expect(Object.keys(config.provider.lmstudio.models)).toEqual(['old', 'new']);
	} finally {
		if (previous === undefined) delete process.env.KILO_CONFIG_CONTENT;
		else process.env.KILO_CONFIG_CONTENT = previous;
	}
});

test('a registered variant goes on the seat agent with its model, so TUI turns keep it', () => {
	const read = (env: NodeJS.ProcessEnv) =>
		JSON.parse(env.KILO_CONFIG_CONTENT ?? '{}') as {
			permission?: string;
			agent: Record<string, unknown>;
		};
	const base = {
		KILO_CONFIG_CONTENT: JSON.stringify({
			permission: 'ask',
			agent: { code: { temperature: 0.2 }, plan: { model: 'x/y' } },
		}),
	};
	const config = read(kiloAgentVariant(base, 'zai/glm-5.3', 'high'));
	expect(config.permission).toBe('ask');
	expect(config.agent.code).toEqual({ temperature: 0.2, model: 'zai/glm-5.3', variant: 'high' });
	expect(config.agent.plan).toEqual({ model: 'x/y' });
	const chosen = read(
		kiloAgentVariant(
			{ KILO_CONFIG_CONTENT: JSON.stringify({ default_agent: 'build' }) },
			'zai/glm-5.3',
			'medium',
		),
	);
	expect(chosen.agent).toEqual({ build: { model: 'zai/glm-5.3', variant: 'medium' } });
	for (const [model, variant] of [
		[undefined, 'high'],
		['zai/glm-5.3', undefined],
	])
		expect(kiloAgentVariant(base, model, variant)).toBe(base);
});

test('Kilo allocates exact IDs over ACP without sending a prompt and rejects malformed IDs', async () => {
	const script = `import * as readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line); if(m.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}}));
else if(m.method==='session/new' && m.params.mcpServers.length===0) console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessionId:process.env.FIXTURE_ID}}));
else process.exit(2); });`;
	let pid = 0;
	const id = await createKiloSession(
		process.cwd(),
		{ ...process.env, FIXTURE_ID: 'ses_owned' },
		(value) => {
			pid = value;
			return Promise.resolve();
		},
		[process.execPath, '-e', script],
	);
	expect(id).toBe('ses_owned');
	expect(pid).toBeGreaterThan(0);
	expect(() => process.kill(pid, 0)).toThrow();
	expect(
		await createKiloSession(
			process.cwd(),
			{ ...process.env, FIXTURE_ID: '../foreign' },
			() => Promise.resolve(),
			[process.execPath, '-e', script],
		).catch((error: unknown) => String(error)),
	).toContain('invalid session ID');
	expect(
		await createKiloSession(process.cwd(), process.env, () => Promise.resolve(), [
			'summon-missing-kilo-executable',
		]).catch((error: unknown) => String(error)),
	).toContain('Cannot start Kilo');
});

test('Kilo CLI preserves exact saved session, model settings and provider permission defaults', async () => {
	const fixture = await cliHarness();
	try {
		await fixture.seed('kilo');
		const result = await fixture.invoke([
			'member',
			'--same-window',
			'--model',
			'lmstudio/local',
			'--lm-studio-url',
			'http://localhost:1234/v1',
		]);
		expect(result.code).toBe(0);
		expect(result.launches[0]?.cmd.slice(0, 6)).toEqual([
			'kilo',
			fixture.project,
			'--session',
			'existing-session',
			'--model',
			'lmstudio/local',
		]);
		expect(result.launches[0]?.cmd).not.toContain('--auto');
		expect((await fixture.saved()).lmStudioUrl).toBe('http://localhost:1234/v1');
		const resumed = await fixture.invoke(['member', '--same-window']);
		expect(resumed.launches[0]?.cmd).toContain('lmstudio/local');
		expect((await fixture.saved()).sessions).toHaveLength(1);
	} finally {
		await fixture.dispose();
	}
});
