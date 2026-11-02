import { spawn } from 'node:child_process';
import { z } from 'zod';

import { requireExecutable } from './executable.ts';

export type CodexTurnPhase = 'busy' | 'idle' | 'unknown';
const MAX_THREADS = 64;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const STATUS_TIMEOUT_MS = 1500;
const threadSchema = z.object({
	id: z.string(),
	status: z.object({ type: z.enum(['active', 'idle', 'notLoaded', 'systemError']) }),
});

/** Only the existing daemon is contacted: no server start, resume, subscription or history read.
 * Contract: https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming
 */
export async function readCodexThreadStatuses(
	threads: readonly string[],
	command?: readonly string[],
): Promise<Map<string, CodexTurnPhase>> {
	const unknown = new Map(threads.map((thread) => [thread, 'unknown' as const]));
	if (
		threads.length === 0 ||
		threads.length > MAX_THREADS ||
		new Set(threads).size !== threads.length ||
		threads.some((thread) => !/^[a-zA-Z0-9_-]{1,128}$/.test(thread))
	)
		return unknown;
	try {
		const args = command ?? [requireExecutable('codex'), 'app-server', 'proxy'];
		const executable = args[0];
		if (!executable) return unknown;
		const child = spawn(executable, args.slice(1), { windowsHide: true, stdio: 'pipe' });
		return await new Promise<Map<string, CodexTurnPhase>>((resolve) => {
			let output = Buffer.alloc(0);
			let bytes = 0;
			let initialized = false;
			let finished = false;
			let complete = false;
			const phases = new Map<string, CodexTurnPhase>();
			const pending = new Set(threads.map((_, index) => index + 2));
			const finish = (success: boolean) => {
				if (finished) return;
				finished = true;
				complete = success;
				child.stdin.end();
				child.kill();
			};
			const timer = setTimeout(() => finish(false), STATUS_TIMEOUT_MS);
			const send = (value: unknown) => {
				try {
					child.stdin.write(`${JSON.stringify(value)}\n`);
				} catch {
					finish(false);
				}
			};
			child.stdin.on('error', () => finish(false));
			child.on('error', () => finish(false));
			child.stderr.resume(); // Never retain provider diagnostics, prompts or paths.
			child.once('exit', () => {
				// An inherited pipe must not keep close pending after the observer has exited.
				child.stdout.destroy();
				child.stderr.destroy();
			});
			child.once('close', () => {
				clearTimeout(timer);
				resolve(complete ? phases : unknown);
			});
			child.stdout.on('data', (chunk: Buffer) => {
				if (finished) return;
				bytes += chunk.length;
				if (bytes > MAX_OUTPUT_BYTES) return finish(false);
				output = Buffer.concat([output, chunk]);
				try {
					let newline: number;
					while ((newline = output.indexOf(10)) !== -1) {
						if (newline > MAX_LINE_BYTES) return finish(false);
						const line = new TextDecoder('utf-8', { fatal: true }).decode(
							output.subarray(0, newline),
						);
						output = output.subarray(newline + 1);
						const raw: unknown = JSON.parse(line);
						if (!raw || typeof raw !== 'object' || Array.isArray(raw))
							return finish(false);
						const response = raw as Record<string, unknown>;
						if (response.id === 1 && !initialized) {
							if (!response.result || response.error) return finish(false);
							initialized = true;
							send({ method: 'initialized', params: {} });
							threads.forEach((threadId, index) =>
								send({
									id: index + 2,
									method: 'thread/read',
									params: { threadId, includeTurns: false },
								}),
							);
						} else if (typeof response.id === 'number' && pending.has(response.id)) {
							if (!initialized) return finish(false);
							const thread = threads[response.id - 2];
							if (!thread) return finish(false);
							const result = z
								.object({ thread: threadSchema })
								.safeParse(response.result);
							const phase =
								!response.error &&
								result.success &&
								result.data.thread.id === thread
									? result.data.thread.status.type
									: 'unknown';
							phases.set(
								thread,
								phase === 'active' ? 'busy' : phase === 'idle' ? 'idle' : 'unknown',
							);
							pending.delete(response.id);
							if (pending.size === 0) return finish(true);
						}
					}
					if (output.length > MAX_LINE_BYTES) finish(false);
				} catch {
					finish(false);
				}
			});
			send({
				id: 1,
				method: 'initialize',
				params: { clientInfo: { name: 'summon_turn_observer', version: '1.0.0' } },
			});
		});
	} catch {
		return unknown;
	}
}
