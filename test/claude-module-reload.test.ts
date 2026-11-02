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

test('generated module reload withdraws old idle; retired completion cannot release a new turn', async () => {
	const fixture = await mailHarness();
	const oldHome = process.env.SUMMON_HOME;
	const oldNonce = process.env.SUMMON_NONCE;
	const nonce = 'module-reload';
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
		const api: Api = {
			env: { get: (name) => Promise.resolve(bridge.env[name as keyof typeof bridge.env]) },
			session: { id: () => Promise.resolve('exact') },
			prompt: { read: () => Promise.resolve({ text: '' }) },
			http: {
				fetch: async (url, init) => {
					const response = await fetch(url, init);
					return { ok: response.ok, text: await response.text() };
				},
			},
		};
		let coreCalls = 0;
		function instance() {
			const handlers = new Map<string, Handler>();
			generated.register((kind, handler) => handlers.set(kind, handler));
			return async (kind: string, event: Metadata = {}) => {
				const handler = handlers.get(kind);
				if (!handler) throw new Error('Missing native module handler.');
				return handler(api, event, (input) => {
					coreCalls++;
					return Promise.resolve(input);
				});
			};
		}
		const original = instance();
		await original('session.start');
		await original('turn.start', { turnId: 'old' });
		await original('turn.complete', { turnId: 'old', reason: 'answer', isAborted: false });
		expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
		const oldEpoch = (await claudeTurn('alpha', nonce))?.epoch;
		const reloaded = instance();
		await reloaded('session.start');
		expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
		await original('classic.Notification', {
			notification_type: 'idle_prompt',
			session_id: 'exact',
		});
		expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
		await reloaded('classic.Notification', {
			notification_type: 'idle_prompt',
			session_id: 'exact',
		});
		expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
		await reloaded('turn.start', { turnId: 'new' });
		expect((await claudeTurn('alpha', nonce))?.epoch).toBe((oldEpoch ?? 0) + 1);
		await original('turn.start', { turnId: 'retired' });
		await original('turn.complete', { turnId: 'retired', reason: 'answer', isAborted: false });
		expect((await claudeTurn('alpha', nonce))?.turn).toBe('new');
		expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
		await reloaded('turn.complete', { turnId: 'new', reason: 'answer', isAborted: false });
		expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
		expect(coreCalls).toBe(10);
	} finally {
		await bridge.stop();
		if (oldHome === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = oldHome;
		if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
		else process.env.SUMMON_NONCE = oldNonce;
		await fixture.dispose();
	}
});
