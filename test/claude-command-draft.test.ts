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

for (const command of ['reload-plugins', 'status', 'model', 'context', 'cost', 'config', 'help'])
	test.each([
		'cleared',
		'kept-draft',
		'new-submit',
		'new-turn',
		'new-attachment',
		'edit-during-read',
		'read-fails',
		'core-fails',
		'unknown',
	] as const)(`local ${command} prompt observation: %s`, async (behavior) => {
		const fixture = await mailHarness();
		const oldHome = process.env.SUMMON_HOME;
		const oldNonce = process.env.SUMMON_NONCE;
		const nonce = 'command-draft';
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
			let afterRead: (() => Promise<void>) | undefined;
			let failRead = false;
			const api: Api = {
				env: {
					get: (name) => Promise.resolve(bridge.env[name as keyof typeof bridge.env]),
				},
				session: { id: () => Promise.resolve('exact') },
				prompt: {
					read: async () => {
						if (failRead) throw new Error('Unavailable prompt');
						const text = draft;
						await afterRead?.();
						return { text };
					},
				},
				http: {
					fetch: async (url, init) => {
						const response = await fetch(url, init);
						return { ok: response.ok, text: await response.text() };
					},
				},
			};
			async function emit(
				kind: string,
				event: Metadata = {},
				next: (input: Metadata) => Promise<Metadata> = (input) => Promise.resolve(input),
			) {
				const handler = handlers.get(kind);
				if (!handler) throw new Error('Missing generated handler');
				return handler(api, event, next);
			}
			await emit('session.start');
			if (behavior !== 'unknown') {
				await emit('turn.start', { turnId: 'first' });
				await emit('turn.complete', {
					turnId: 'first',
					reason: 'answer',
					isAborted: false,
				});
			}
			draft = '/' + command;
			await emit('prompt.edit', { text: draft });
			expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
			const coreError = new Error('Native command failed');
			let calls = 0;
			const run = emit('command.run', { command }, async () => {
				calls++;
				if (behavior === 'core-fails') throw coreError;
				draft = behavior === 'kept-draft' ? 'unsent text' : '';
				if (behavior === 'new-submit') await emit('prompt.submit', { text: 'next' });
				if (behavior === 'new-turn') await emit('turn.start', { turnId: 'new' });
				if (behavior === 'new-attachment') await emit('session.start');
				if (behavior === 'read-fails') failRead = true;
				if (behavior === 'edit-during-read')
					afterRead = async () => {
						draft = 'new unsent text';
						await emit('prompt.edit', { text: draft });
					};
				return { text: 'Unchanged native result' };
			});
			if (behavior === 'core-fails')
				expect(await run.catch((error: unknown) => error)).toBe(coreError);
			else expect(await run).toEqual({ text: 'Unchanged native result' });
			expect(calls).toBe(1);
			expect(await claudeNoticeAllowed('alpha', nonce)).toBe(behavior === 'cleared');
			const state = await claudeTurn('alpha', nonce);
			if (behavior === 'cleared') expect(state?.draft).toBe(false);
			if (behavior === 'unknown' || behavior === 'new-attachment')
				expect(state?.phase).toBe('unknown');
			if (behavior === 'new-turn') expect(state?.turn).toBe('new');
		} finally {
			await bridge.stop();
			if (oldHome === undefined) delete process.env.SUMMON_HOME;
			else process.env.SUMMON_HOME = oldHome;
			if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
			else process.env.SUMMON_NONCE = oldNonce;
			await fixture.dispose();
		}
	});
