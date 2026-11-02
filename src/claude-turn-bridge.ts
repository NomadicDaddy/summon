import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

import { observeClaudeModel } from './claude-model-observation.ts';
import { claudeTurnModule } from './claude-turn-module.ts';
import {
	attachClaudeObserver,
	initializeClaudeTurn,
	invalidateClaudeTurn,
	observeClaudeTurn,
} from './claude-turn-state.ts';
import { retainClaudeCompaction } from './compaction-observers.ts';
import { atomicWrite } from './mail-files.ts';
import { runtimePath } from './mail-session.ts';

/** Launch-owned endpoint; its bearer stays in memory/environment, never files or prompts. */
export async function startClaudeTurnBridge(name: string, nonce: string, thread: string) {
	const observer = randomUUID();
	await initializeClaudeTurn(name, nonce, thread, observer);
	const key = randomBytes(32).toString('hex');
	let closed = false;
	let pending = Promise.resolve();
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		maxRequestBodySize: 16_384,
		async fetch(request) {
			const received = Buffer.from(request.headers.get('authorization') ?? '');
			const expected = Buffer.from(`Bearer ${key}`);
			if (received.length !== expected.length || !timingSafeEqual(received, expected))
				return new Response(null, { status: 403 });
			const path = new URL(request.url).pathname;
			if (
				closed ||
				request.method !== 'POST' ||
				!['/turn', '/attach', '/model'].includes(path)
			)
				return new Response(null, { status: 404 });
			const operation = pending.then(async () => {
				if (closed) return new Response(null, { status: 410 });
				if (path === '/model') {
					try {
						await observeClaudeModel(name, nonce, observer, await request.json());
						return new Response(null, { status: 204 });
					} catch {
						// A model metadata failure must not withdraw turn-completion authority.
						return new Response(null, { status: 400 });
					}
				}
				try {
					if (path === '/attach') {
						const body = z
							.object({ session: z.string().min(1).max(128) })
							.strict()
							.parse(await request.json());
						const epoch = await attachClaudeObserver(
							name,
							nonce,
							observer,
							body.session,
						);
						return Response.json({ epoch });
					}
					const event: unknown = await request.json();
					await observeClaudeTurn(name, nonce, observer, event);
					// History storage failure must not discard verified native completion authority.
					await retainClaudeCompaction(name, nonce, observer, event).catch(() => {
						console.error(
							'Summon compaction history could not retain an observed event.',
						);
					});
					return new Response(null, { status: 204 });
				} catch {
					await invalidateClaudeTurn(name, nonce, observer);
					return new Response(null, { status: 400 });
				}
			});
			pending = operation.then(
				() => {},
				() => {},
			);
			return operation;
		},
	});
	const directory = join(runtimePath(name), `${nonce}.claude-mod`);
	try {
		await atomicWrite(
			join(directory, '.claude-plugin', 'plugin.json'),
			JSON.stringify({
				name: 'summon-native-turns',
				version: '1.0.0',
				description:
					'Report owned native turn and draft metadata without changing prompts or tools.',
				author: { name: 'Summon' },
			}),
		);
		await atomicWrite(
			join(directory, 'hooks', 'hooks.json'),
			JSON.stringify({
				modules: ['./register.js'],
			}),
		);
		await atomicWrite(join(directory, 'hooks', 'register.js'), claudeTurnModule);
	} catch (error: unknown) {
		await server.stop(true);
		await invalidateClaudeTurn(name, nonce, observer);
		throw error;
	}
	return {
		args: ['--plugin-dir', directory],
		env: {
			SUMMON_CLAUDE_TURN_URL: `http://127.0.0.1:${server.port}/turn`,
			SUMMON_CLAUDE_TURN_KEY: key,
		},
		async stop(): Promise<void> {
			closed = true;
			await server.stop(true);
			await pending;
			await invalidateClaudeTurn(name, nonce, observer);
		},
	};
}
