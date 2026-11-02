import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { initializeActivity } from '../src/agent-activity.ts';
import { initializeClaudeTurn } from '../src/claude-turn-state.ts';
import { deliveryNotice } from '../src/mail-notice.ts';
import { loadAgent, updateAgentRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { observeFixtureClaudeIdle } from './fixtures/wake-team.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const oldHome = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	await fixture.dispose();
});

async function eventually(check: () => Promise<boolean> | boolean): Promise<void> {
	for (let i = 0; i < 60; i++) {
		if (await check()) return;
		await Bun.sleep(100);
	}
	throw new Error('Expected mail state was not observed.');
}

test('delivery notices name holds without including mail', () => {
	const readiness = deliveryNotice('beta', 'nonce-1', false, 2, 1);
	expect(readiness).toContain('summon --mail ready nonce-1');
	expect(readiness).toContain('summon --mail holds');
	const decision = deliveryNotice('beta', 'nonce-1', true, 0, 1);
	expect(decision).toContain('summon --mail holds');
	expect(decision).not.toContain('summon --mail receive');
	expect(decision).not.toContain('secret proposal');
	const work = deliveryNotice('beta', 'nonce-1', true, 2, 0);
	expect(work).toContain('summon --current-requests --format text before historical catch-up');
	expect(work).toContain('then use summon-receive');
});

test('checkpoint Claude MCP tools do not own a receiver or emit channel notices', async () => {
	const client = new Client({ name: 'checkpoint-test', version: '1' });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [join(import.meta.dir, '../src/claude-mail-channel.ts')],
		env: {
			SUMMON_HOME: fixture.records,
			SUMMON_AGENT: 'beta',
			SUMMON_NONCE: 'checkpoint-fixture',
			SUMMON_CLAUDE_CHANNEL: '0',
			PATH: process.env.PATH ?? '',
		},
		stderr: 'pipe',
	});
	try {
		await client.connect(transport);
		expect(client.getServerCapabilities()?.experimental).toBeUndefined();
		expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('mail');
		await Bun.sleep(100);
		expect(
			await Bun.file(join(fixture.records, 'runtime/beta/receiver/owner.json')).exists(),
		).toBe(false);
	} finally {
		await client.close();
	}
});

test('stdio channel requires receipt, isolates ownership, delivers later mail, and cleans up', async () => {
	await initializeClaudeTurn('beta', 'test-launch', 'disposable-thread', 'fixture-observer');
	await observeFixtureClaudeIdle('beta', 'test-launch');
	const events: string[] = [];
	const client = new Client({ name: 'summon-test', version: '1' });
	client.setNotificationHandler(
		z.object({
			method: z.literal('notifications/claude/channel'),
			params: z.object({ content: z.string() }),
		}),
		(event) => {
			events.push(event.params.content);
		},
	);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [
			'--preload',
			join(import.meta.dir, 'fixtures/telegram-fetch.ts'),
			join(import.meta.dir, '../src/claude-mail-channel.ts'),
		],
		env: {
			SUMMON_HOME: fixture.records,
			SUMMON_AGENT: 'beta',
			SUMMON_NONCE: 'test-launch',
			SUMMON_TEST_UPDATES: join(fixture.root, 'updates.json'),
			SUMMON_CLAUDE_CHANNEL: '1',
			// This child gets a declared environment rather than an inherited one, so the
			// suite-wide collapsed notice window has to be named here too.
			SUMMON_ROOM_WAKE_QUIET_MS: '0',
			PATH: process.env.PATH ?? '',
		},
		stderr: 'pipe',
	});
	try {
		await client.connect(transport);
		await eventually(() => events.length > 0);
		expect(
			JSON.stringify(
				await client.callTool({ name: 'mail', arguments: { args: ['status'] } }),
			),
		).toContain('unconfirmed');
		expect(
			JSON.stringify(
				await client.callTool({ name: 'mail', arguments: { args: ['status'] } }),
			),
		).toContain('Awaiting explicit launch readiness acknowledgment');
		expect(
			(await client.callTool({ name: 'mail', arguments: { args: ['check', 'alpha'] } }))
				.isError,
		).toBe(true);
		expect(
			(
				await client.callTool({
					name: 'mail',
					arguments: { args: ['ready', 'wrong-launch'] },
				})
			).isError,
		).toBe(true);
		// One readiness bootstrap is not replayed; later work waits for native completion.
		await observeFixtureClaudeIdle('beta', 'test-launch');
		await fixture.run(['--mail', 'send-self', 'beta', 'Readiness recovery'], 'alpha');
		await eventually(() => events.length > 1);
		expect(events[1]).not.toContain('summon --mail ready');
		expect(events[1]).not.toContain('Readiness recovery');
		await client.callTool({ name: 'mail', arguments: { args: ['receive'] } });
		await client.callTool({ name: 'mail', arguments: { args: ['ready', 'test-launch'] } });
		await eventually(async () =>
			JSON.stringify(
				await client.callTool({ name: 'mail', arguments: { args: ['status'] } }),
			).includes('live'),
		);
		await fixture.run(['--mail', 'send-self', 'beta', 'Fresh mail'], 'alpha');
		await observeFixtureClaudeIdle('beta', 'test-launch');
		await eventually(() => events.length > 2);
		expect(events[2]).not.toContain('Fresh mail');
		expect(events[2]).not.toContain('summon --mail ready');
		expect(
			JSON.stringify(
				await client.callTool({ name: 'mail', arguments: { args: ['receive'] } }),
			),
		).toContain('Fresh mail');
		await fixture.run(['--room', 'send', 'Local-only conversation'], 'alpha');
		const local = await client.callTool({
			name: 'room',
			arguments: { action: 'read', room: 'local' },
		});
		expect(JSON.stringify(local)).toContain('Local-only conversation');
		await client.callTool({
			name: 'room',
			arguments: { action: 'ack', cursor: '1', room: 'local' },
		});
		expect(await fixture.read('runtime/beta/room.cursor')).toBe('1');
		await mkdir(join(fixture.records, 'integrations'));
		await writeFile(
			join(fixture.records, 'integrations/telegram.json'),
			JSON.stringify({ botToken: '123:test', chatId: '456' }),
		);
		await writeFile(
			join(fixture.root, 'updates.json'),
			JSON.stringify([
				{
					update_id: 1,
					message: {
						message_id: 1,
						chat: { id: 456 },
						from: { id: 456, is_bot: false },
						text: 'Later room message',
					},
				},
			]),
		);
		await observeFixtureClaudeIdle('beta', 'test-launch');
		await eventually(() => events.some((text) => text.includes('summon Telegram')));
		const page = await client.callTool({
			name: 'room',
			arguments: { action: 'read', room: 'telegram' },
		});
		expect(JSON.stringify(page)).toContain('Later room message');
		await client.callTool({
			name: 'room',
			arguments: { action: 'ack', cursor: '1', room: 'telegram' },
		});
		expect(await fixture.read('runtime/beta/telegram-123-456.cursor')).toBe('1');
	} finally {
		await client.close();
	}
	await eventually(async () =>
		(await fixture.read('runtime/beta/test-launch.json')).includes('queued-only'),
	);
}, 15000);

test('session hook binds only a root session and refuses a conflicting identity', async () => {
	await updateAgentRecord('beta', (record) => {
		record.provider = 'codex';
	});
	await initializeActivity('beta', 'test-launch', 'codex');
	const { mkdir, writeFile } = await import('node:fs/promises');
	await mkdir(join(fixture.records, 'runtime/beta'), { recursive: true });
	await writeFile(
		join(fixture.records, 'runtime/beta/test-launch.json'),
		JSON.stringify({
			nonce: 'test-launch',
			pid: process.pid,
			state: 'queued-only',
			reason: '',
			thread: 'thread-1234',
		}),
	);
	async function hook(id: string, agentId?: string, source = 'resume') {
		const child = Bun.spawn({
			cmd: [process.execPath, join(import.meta.dir, '../src/cli.ts'), '__mail-bind'],
			env: {
				...process.env,
				SUMMON_HOME: fixture.records,
				SUMMON_AGENT: 'beta',
				SUMMON_NONCE: 'test-launch',
			},
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		});
		await child.stdin.write(
			JSON.stringify({
				hook_event_name: 'SessionStart',
				source,
				session_id: id,
				agent_id: agentId,
			}),
		);
		await child.stdin.end();
		const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		if (code !== 0) expect(error).toMatch(/does not match|Invalid session ID/);
		return code;
	}
	expect(await hook('thread-other', 'child-agent')).toBe(0);
	expect(await hook('--dangerous-flag')).toBe(1);
	expect(await hook('thread-other')).toBe(1);
	expect(await hook('thread-1234')).toBe(0);
	const bound = await fixture.run(['--mail', 'bind'], 'beta', { CODEX_THREAD_ID: 'thread-1234' });
	expect(bound.code).toBe(0);
	expect(bound.out).toContain('thread-1234');
	expect((await loadAgent('beta'))?.sessions.at(-1)?.id).toBe('thread-1234');
	const wrong = await fixture.run(['--mail', 'bind'], 'beta', {
		CODEX_THREAD_ID: 'thread-other',
	});
	expect(wrong.code).toBe(1);
	expect(wrong.error).toContain('does not match');
	expect(await fixture.read('runtime/beta/test-launch.binding')).toBe('thread-1234');
	expect(await hook('thread-cleared', undefined, 'clear')).toBe(0);
	expect(await fixture.read('runtime/beta/test-launch.binding')).toBe('thread-cleared');
	expect((await loadAgent('beta'))?.sessions.at(-1)?.id).toBe('thread-cleared');
});
