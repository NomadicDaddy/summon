import { randomUUID } from 'node:crypto';

import { retainKiloCompaction } from './compaction-observers.ts';
import { initializeKiloTurn, invalidateKiloTurn, observeKiloTurn } from './kilo-turn-state.ts';

const MAX_EVENT_BYTES = 1024 * 1024;

/** Consume one connection sequentially. No reconnect or snapshot absence can manufacture idle. */
export async function observeKiloStream(
	response: Response,
	signal: AbortSignal,
	launch: { name: string; nonce: string },
	observer: string,
	modelChanged?: () => void,
): Promise<void> {
	if (
		!response.ok ||
		!response.headers.get('content-type')?.startsWith('text/event-stream') ||
		!response.body
	)
		throw new Error('Kilo completion stream is unavailable.');
	const reader = response.body.getReader();
	const abort = (): void => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener('abort', abort, { once: true });
	const decoder = new TextDecoder('utf-8', { fatal: true });
	let pending = '';
	let data: string[] = [];
	let bytes = 0;
	try {
		while (!signal.aborted) {
			const chunk = await reader.read();
			if (chunk.done) break;
			pending += decoder.decode(chunk.value, { stream: true });
			if (Buffer.byteLength(pending) > MAX_EVENT_BYTES)
				throw new Error('Kilo completion event is too large.');
			let newline: number;
			while ((newline = pending.indexOf('\n')) !== -1) {
				signal.throwIfAborted();
				const line = pending.slice(0, newline).replace(/\r$/, '');
				pending = pending.slice(newline + 1);
				if (line.startsWith('data:')) {
					const part = line.slice(5).replace(/^ /, '');
					bytes += Buffer.byteLength(part);
					if (bytes > MAX_EVENT_BYTES)
						throw new Error('Kilo completion event is too large.');
					data.push(part);
				} else if (line === '' && data.length) {
					let event: unknown;
					try {
						event = JSON.parse(data.join('\n')) as unknown;
					} catch {
						throw new Error('Invalid Kilo completion event.');
					}
					data = [];
					bytes = 0;
					await observeKiloTurn(launch.name, launch.nonce, observer, event);
					if (
						event &&
						typeof event === 'object' &&
						'type' in event &&
						(event.type === 'session.updated' || event.type === 'session.status')
					)
						modelChanged?.();
					await retainKiloCompaction(launch.name, launch.nonce, observer, event).catch(
						() => {
							console.error(
								'Summon compaction history could not retain an observed event.',
							);
						},
					);
				}
			}
		}
		if (!signal.aborted) throw new Error('Kilo completion stream closed.');
	} finally {
		signal.removeEventListener('abort', abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
		await invalidateKiloTurn(launch.name, launch.nonce, observer);
	}
}

/** Credentials stay in this request's memory, scoped to the exact separately owned worker. */
export async function startKiloTurnStream(
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
	launch: { name: string; nonce: string },
	sessionId: string,
	modelChanged?: () => void,
): Promise<{ completion: Promise<void> }> {
	const observer = randomUUID();
	await initializeKiloTurn(launch.name, launch.nonce, sessionId, observer);
	const connect = new AbortController();
	const combined = AbortSignal.any([signal, connect.signal]);
	const timer = setTimeout(() => connect.abort(), 5000);
	let response: Response;
	try {
		try {
			response = await fetch(url, { headers, redirect: 'error', signal: combined });
		} finally {
			clearTimeout(timer);
		}
		if (
			!response.ok ||
			!response.headers.get('content-type')?.startsWith('text/event-stream') ||
			!response.body
		) {
			await response.body?.cancel();
			throw new Error('Kilo completion stream is unavailable.');
		}
	} catch (error: unknown) {
		// A stream that never opened must not leave its observer looking attached.
		await invalidateKiloTurn(launch.name, launch.nonce, observer);
		throw error;
	}
	const completion = observeKiloStream(response, combined, launch, observer, modelChanged);
	return { completion };
}
