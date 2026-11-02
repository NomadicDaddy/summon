import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';

import { initializeActivity, readActivity } from '../src/agent-activity.ts';
import { kiloStartup } from '../src/kilo-startup.ts';
import { launchReady } from '../src/launch-phase.ts';
import * as launchPhases from '../src/launch-phase.ts';
import { bindSession } from '../src/mail-session-hook.ts';
import { saveDelivery } from '../src/mail-session.ts';
import { updateAgentRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
};
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'test-launch';
});
afterEach(async () => {
	for (const [key, value] of Object.entries({
		SUMMON_HOME: previous.home,
		SUMMON_AGENT: previous.agent,
		SUMMON_NONCE: previous.nonce,
	})) {
		if (value === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = value;
	}
	await fixture.dispose();
});

for (const mode of ['0', '1']) {
	test(`Claude MCP initialization observes CLI-up in channel mode ${mode}`, async () => {
		await initializeActivity('alpha', 'test-launch', 'claude');
		const client = new Client({ name: 'launch-phase-fixture', version: '1' });
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [join(import.meta.dir, '../src/claude-mail-channel.ts')],
			env: {
				SUMMON_HOME: fixture.records,
				SUMMON_AGENT: 'alpha',
				SUMMON_NONCE: 'test-launch',
				SUMMON_CLAUDE_CHANNEL: mode,
				PATH: process.env.PATH ?? '',
			},
			stderr: 'pipe',
		});
		try {
			await client.connect(transport);
			for (
				let i = 0;
				i < 100 && (await readActivity('alpha'))?.launch?.phase === 'connecting';
				i++
			)
				await Bun.sleep(10);
			expect((await readActivity('alpha'))?.launch).toMatchObject({
				phase: 'logging-in',
				evidence: 'claude-mcp-initialized',
			});
			if (mode === '0')
				expect(
					await Bun.file(
						join(fixture.records, 'runtime/alpha/receiver/owner.json'),
					).exists(),
				).toBe(false);
		} finally {
			await client.close();
		}
	});
}

test('Codex exact SessionStart advances only its launch and cannot revive completed status', async () => {
	await updateAgentRecord('alpha', (record) => {
		record.provider = 'codex';
	});
	await initializeActivity('alpha', 'test-launch', 'codex');
	await saveDelivery('alpha', {
		nonce: 'test-launch',
		pid: process.pid,
		state: 'queued-only',
		reason: '',
		thread: 'codex-owned',
	});
	const event = { hook_event_name: 'SessionStart', source: 'resume', session_id: 'codex-owned' };
	await bindSession({ ...event, agent_id: 'subagent' });
	expect((await readActivity('alpha'))?.launch?.phase).toBe('connecting');
	expect(await bindSession({ ...event, session_id: 'other' }).catch(String)).toContain(
		'does not match',
	);
	await bindSession(event);
	expect((await readActivity('alpha'))?.launch).toMatchObject({
		phase: 'logging-in',
		evidence: 'codex-session-start',
	});
	await launchReady('alpha', 'test-launch');
	await bindSession(event);
	expect((await readActivity('alpha'))?.launch?.phase).toBe('startup');
	expect((await fixture.run(['--status', 'needs-user', 'Choose next work'], 'alpha')).code).toBe(
		0,
	);
	await bindSession(event);
	expect((await readActivity('alpha'))?.launch).toBeUndefined();
	await initializeActivity('alpha', 'new-launch', 'codex');
	expect(await bindSession(event).catch(String)).toContain('current launch');
	expect((await readActivity('alpha'))?.nonce).toBe('new-launch');
	expect((await readActivity('alpha'))?.launch?.phase).toBe('connecting');
});

test('Kilo marks CLI-up after exact authenticated GET and before its single startup POST', async () => {
	await initializeActivity('alpha', 'test-launch', 'kilo');
	const startup = await kiloStartup('/fixture', 'kilo-owned', undefined, {
		name: 'alpha',
		nonce: 'test-launch',
	});
	let gets = 0,
		posts = 0;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: Number(startup.args.at(-1)),
		async fetch(request) {
			expect(request.headers.get('authorization')).toBe(
				`Basic ${Buffer.from(`kilo:${startup.env.KILO_SERVER_PASSWORD}`).toString('base64')}`,
			);
			const phase = (await readActivity('alpha'))?.launch;
			if (new URL(request.url).pathname === '/event')
				return new Response(null, { status: 404 });
			if (request.method === 'GET') {
				gets++;
				expect(new URL(request.url).pathname).toBe('/session/kilo-owned');
				expect(phase?.phase).toBe('connecting');
				return new Response(null, { status: gets === 1 ? 503 : 200 });
			}
			posts++;
			expect(phase).toMatchObject({ phase: 'logging-in', evidence: 'kilo-owned-session' });
			expect((await readActivity('alpha'))?.state).toBe('idle');
			return new Response(null, { status: 204 });
		},
	});
	try {
		await startup.start(AbortSignal.timeout(2000));
		expect(gets).toBe(2);
		expect(posts).toBe(1);
	} finally {
		await server.stop(true);
	}
});

test('Kilo authentication failure and abort leave Connecting without a startup POST', async () => {
	await initializeActivity('alpha', 'test-launch', 'kilo');
	const startup = await kiloStartup('/fixture', 'kilo-owned', undefined, {
		name: 'alpha',
		nonce: 'test-launch',
	});
	const abort = new AbortController();
	let posts = 0;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: Number(startup.args.at(-1)),
		fetch(request) {
			if (request.method === 'POST') posts++;
			abort.abort();
			return new Response(null, { status: 401 });
		},
	});
	try {
		expect(await startup.start(abort.signal).catch(String)).toContain('Abort');
		expect(posts).toBe(0);
		expect((await readActivity('alpha'))?.launch?.phase).toBe('connecting');
	} finally {
		await server.stop(true);
	}
});

test('a failed phase observation cannot block Kilo startup or disclose its error payload', async () => {
	await initializeActivity('alpha', 'test-launch', 'kilo');
	const observe = spyOn(launchPhases, 'providerUp').mockRejectedValue(
		new Error('FIXTURE_PRIVATE_PAYLOAD'),
	);
	const warnings: unknown[][] = [];
	const stderr = spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
		warnings.push(values);
	});
	const startup = await kiloStartup('/fixture', 'kilo-owned', undefined, {
		name: 'alpha',
		nonce: 'test-launch',
	});
	let posts = 0;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: Number(startup.args.at(-1)),
		fetch(request) {
			if (request.method === 'POST') posts++;
			return new Response(null, { status: request.method === 'POST' ? 204 : 200 });
		},
	});
	try {
		await startup.start(AbortSignal.timeout(2000));
		expect(posts).toBe(1);
		expect(warnings).toEqual([
			['Kilo completion unavailable; ordinary notices remain queued.'],
			['Launch phase update could not be saved; startup transport continues.'],
		]);
		expect(JSON.stringify(warnings)).not.toContain('FIXTURE_PRIVATE_PAYLOAD');
		expect((await readActivity('alpha'))?.launch?.phase).toBe('connecting');
	} finally {
		observe.mockRestore();
		stderr.mockRestore();
		await server.stop(true);
	}
});
