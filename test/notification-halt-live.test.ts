import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { z } from 'zod';

import { initializeClaudeTurn } from '../src/claude-turn-state.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { observeFixtureClaudeIdle } from './fixtures/wake-team.ts';

test('live Claude channel cannot send readiness while halted and resumes after proceed', async () => {
	const fixture = await mailHarness();
	const oldHome = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = fixture.records;
	await initializeClaudeTurn('beta', 'halt-channel', 'disposable-thread', 'fixture-observer');
	await observeFixtureClaudeIdle('beta', 'halt-channel');
	const events: string[] = [];
	const client = new Client({ name: 'halt-test', version: '1' });
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
		args: [join(import.meta.dir, '../src/claude-mail-channel.ts')],
		env: {
			SUMMON_HOME: fixture.records,
			SUMMON_AGENT: 'beta',
			SUMMON_NONCE: 'halt-channel',
			SUMMON_CLAUDE_CHANNEL: '1',
			SUMMON_ROOM_WAKE_QUIET_MS: '0',
			PATH: process.env.PATH ?? '',
		},
		stderr: 'pipe',
	});
	try {
		expect((await fixture.run(['--comms', 'halt'])).code).toBe(0);
		await client.connect(transport);
		await Bun.sleep(2500);
		expect(events).toEqual([]);
		expect((await fixture.run(['--comms', 'proceed'])).code).toBe(0);
		for (let i = 0; i < 60 && events.length === 0; i++) await Bun.sleep(100);
		expect(events).toHaveLength(1);
		expect(events[0]).toContain('summon --mail ready halt-channel');
	} finally {
		if (oldHome === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = oldHome;
		await client.close();
		await fixture.dispose();
	}
}, 15000);
