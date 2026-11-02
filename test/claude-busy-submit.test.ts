import { expect, test } from 'bun:test';

import { startClaudeTurnBridge } from '../src/claude-turn-bridge.ts';
import { claudeTurnModule } from '../src/claude-turn-module.ts';
import { claudeInputSubmitted, claudeNoticeAllowed, claudeTurn } from '../src/claude-turn-state.ts';
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

test.each(['same', 'newer', 'draft', 'aborted', 'early-completion'] as const)(
	'busy native submission preserves completion while guarding %s turn',
	async (behavior) => {
		const fixture = await mailHarness();
		const oldHome = process.env.SUMMON_HOME;
		const oldNonce = process.env.SUMMON_NONCE;
		const nonce = 'busy-submit';
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
			let draft = '';
			const api: Api = {
				env: {
					get: (name) => Promise.resolve(bridge.env[name as keyof typeof bridge.env]),
				},
				session: { id: () => Promise.resolve('exact') },
				prompt: { read: () => Promise.resolve({ text: draft }) },
				http: {
					fetch: async (url, init) => {
						const response = await fetch(url, init);
						return { ok: response.ok, text: await response.text() };
					},
				},
			};
			async function emit(kind: string, event: Metadata = {}) {
				const handler = handlers.get(kind);
				if (!handler) throw new Error('Missing generated handler.');
				return handler(api, event, (input) => Promise.resolve(input));
			}
			await emit('session.start');
			await emit('turn.start', { turnId: 'running' });
			await claudeInputSubmitted('alpha', nonce);
			// A completion before the physical submission reaches native core cannot release it.
			if (behavior === 'early-completion')
				await emit('turn.complete', {
					turnId: 'running',
					reason: 'answer',
					isAborted: false,
				});
			expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
			expect((await claudeTurn('alpha', nonce))?.turn).toBeNull();
			for (let index = 0; index < 2; index++) {
				expect(await emit('prompt.submit', { text: 'private fixture message' })).toEqual({
					text: 'private fixture message',
				});
				expect((await claudeTurn('alpha', nonce))?.turn).toBe(
					behavior === 'early-completion' ? null : 'running',
				);
				expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
			}
			if (behavior === 'newer' || behavior === 'early-completion')
				await emit('turn.start', { turnId: 'newer' });
			if (behavior === 'draft') draft = 'unsent human text';
			await emit('turn.complete', {
				turnId: 'running',
				reason: behavior === 'aborted' ? 'aborted' : 'answer',
				isAborted: behavior === 'aborted',
			});
			expect(await claudeNoticeAllowed('alpha', nonce)).toBe(behavior === 'same');
			if (behavior === 'newer' || behavior === 'early-completion') {
				expect((await claudeTurn('alpha', nonce))?.turn).toBe('newer');
				await emit('turn.complete', {
					turnId: 'newer',
					reason: 'answer',
					isAborted: false,
				});
				expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
			}
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
