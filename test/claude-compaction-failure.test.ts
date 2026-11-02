import { expect, test } from 'bun:test';

import { startClaudeTurnBridge } from '../src/claude-turn-bridge.ts';
import { claudeTurnModule } from '../src/claude-turn-module.ts';
import { claudeNoticeAllowed, claudeTurn } from '../src/claude-turn-state.ts';
import { markReady, saveDelivery } from '../src/mail-session.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

type Metadata = Record<string, unknown>;
type Api = {
	env: { get: (name: string) => Promise<string | undefined> };
	session: { id: () => Promise<string> };
	prompt: { read: () => Promise<{ text: string }> };
	http: { fetch: (url: string, init: RequestInit) => Promise<{ ok: boolean; text: string }> };
};
type Handler = (
	api: Api,
	event: Metadata,
	next: (event: Metadata) => Promise<Metadata>,
) => Promise<unknown>;
type Module = { register: (on: (kind: string, handler: Handler) => void) => void };

test.each(['success', 'error', 'abort', 'nested', 'read-error', 'end-error'] as const)(
	'actual compaction hook preserves core and balances the %s lifecycle',
	async (behavior) => {
		const fixture = await mailHarness();
		const oldHome = process.env.SUMMON_HOME;
		const oldNonce = process.env.SUMMON_NONCE;
		const nonce = 'compaction-failure';
		process.env.SUMMON_HOME = fixture.records;
		process.env.SUMMON_NONCE = nonce;
		const bridge = await startClaudeTurnBridge('alpha', nonce, 'exact');
		try {
			await saveDelivery('alpha', {
				nonce,
				thread: 'exact',
				pid: process.pid,
				state: 'unconfirmed',
				reason: '',
			});
			await markReady('alpha', nonce);
			const generated = (await import(
				'data:text/javascript;base64,' + Buffer.from(claudeTurnModule).toString('base64')
			)) as Module;
			const handlers = new Map<string, Handler>();
			generated.register((kind, handler) => handlers.set(kind, handler));
			let failRead = false;
			let failEnd = false;
			const api: Api = {
				env: {
					get: (name) => Promise.resolve(bridge.env[name as keyof typeof bridge.env]),
				},
				session: { id: () => Promise.resolve('exact') },
				prompt: {
					read: () =>
						failRead
							? Promise.reject(new Error('Composer unavailable'))
							: Promise.resolve({ text: '' }),
				},
				http: {
					fetch: async (url, init) => {
						if (failEnd) throw new Error('Observer unavailable');
						const response = await fetch(url, init);
						return { ok: response.ok, text: await response.text() };
					},
				},
			};
			async function emit(
				kind: string,
				event: Metadata = {},
				next: (event: Metadata) => Promise<Metadata> = (input) => Promise.resolve(input),
			) {
				const handler = handlers.get(kind);
				if (!handler) throw new Error('Missing generated handler.');
				return handler(api, event, next);
			}
			await emit('session.start');
			await emit('turn.start', { turnId: 'root' });
			const original =
				behavior === 'abort'
					? new DOMException('Core cancelled', 'AbortError')
					: new Error('Core failed');
			const result = { messages: [{ text: 'private fixture' }] };
			let calls = 0;
			const compact = emit('session.compact', {}, async () => {
				calls++;
				expect((await claudeTurn('alpha', nonce))?.compactions).toBe(1);
				expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
				if (behavior === 'nested') {
					await emit('session.compact', {}, async () => {
						expect((await claudeTurn('alpha', nonce))?.compactions).toBe(2);
						return result;
					});
					expect((await claudeTurn('alpha', nonce))?.compactions).toBe(1);
				}
				failRead = behavior === 'read-error';
				failEnd = behavior === 'end-error';
				if (behavior === 'success' || behavior === 'nested') return result;
				throw original;
			});
			if (behavior === 'success' || behavior === 'nested') expect(await compact).toBe(result);
			else {
				let caught: unknown;
				try {
					await compact;
				} catch (error) {
					caught = error;
				}
				expect(caught).toBe(original);
			}
			expect(calls).toBe(1);
			expect((await claudeTurn('alpha', nonce))?.compactions).toBe(
				behavior === 'end-error' ? 1 : 0,
			);
			if (behavior === 'read-error')
				expect((await claudeTurn('alpha', nonce))?.draft).toBe(true);
			expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
			failRead = false;
			failEnd = false;
			await emit('turn.complete', { turnId: 'root', reason: 'answer', isAborted: false });
			expect(await claudeNoticeAllowed('alpha', nonce)).toBe(behavior !== 'end-error');
		} finally {
			await bridge.stop();
			if (oldHome === undefined) delete process.env.SUMMON_HOME;
			else process.env.SUMMON_HOME = oldHome;
			if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
			else process.env.SUMMON_NONCE = oldNonce;
			await fixture.dispose();
		}
	},
);
