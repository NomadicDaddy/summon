import { expect } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { newRecord } from '../../src/store.ts';
export function update(id: number, text: string, extra: Record<string, unknown> = {}) {
	return {
		update_id: id,
		message: {
			message_id: id,
			chat: { id: 456, type: 'private' },
			from: { id: 456, is_bot: false },
			text,
			date: Math.floor(Date.now() / 1000),
			...extra,
		},
	};
}

export interface RoomPage {
	events: {
		sequence: number;
		messageId: number;
		sender: { kind: string; id: string };
		replyTo: number | null;
		text: string;
	}[];
	nextCursor: number;
	more: boolean;
}

export async function telegramHarness() {
	const root = await mkdtemp(join(tmpdir(), 'summon-telegram-'));
	await writeFile(
		join(root, 'test-agent.json'),
		JSON.stringify(newRecord('test-agent', root, 'claude')),
	);
	await mkdir(join(root, 'integrations'));
	await writeFile(
		join(root, 'integrations', 'telegram.json'),
		JSON.stringify({ botToken: '123:fake-test-token', chatId: '456' }),
	);
	async function invoke(
		args: string[],
		mode = 'success',
		agent = 'test-agent',
		messageId = '42',
		channel = '--telegram',
	) {
		const child = Bun.spawn({
			cmd: [
				process.execPath,
				'--preload',
				resolve('test/fixtures/telegram-fetch.ts'),
				resolve('src/cli.ts'),
				channel,
				...args,
			],
			env: {
				...process.env,
				SUMMON_HOME: root,
				SUMMON_AGENT: agent,
				SUMMON_NONCE: 'test-nonce',
				SUMMON_TEST_TELEGRAM: mode,
				SUMMON_TEST_CAPTURE: join(root, 'capture'),
				SUMMON_TEST_UPDATES: join(root, 'updates.json'),
				SUMMON_TEST_MESSAGE_ID: messageId,
			},
			stdout: 'pipe',
			stderr: 'pipe',
			stdin: 'ignore',
		});
		return {
			code: await child.exited,
			out: await new Response(child.stdout).text(),
			err: await new Response(child.stderr).text(),
		};
	}

	async function readRoom(after?: string): Promise<RoomPage> {
		const result = await invoke(after ? ['read', after] : ['read']);
		expect(result.code).toBe(0);
		return JSON.parse(result.out) as RoomPage;
	}

	async function dispose() {
		if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('summon-telegram-'))
			throw new Error('Unexpected test directory.');
		await rm(root, { recursive: true, force: true, maxRetries: 3 });
	}
	return { root, invoke, readRoom, dispose };
}
