import { afterEach, beforeEach, expect, test } from 'bun:test';

import { startClaudeTurnBridge } from '../src/claude-turn-bridge.ts';
import { claudeTurnModule } from '../src/claude-turn-module.ts';
import { claudeNoticeAllowed, claudeTurn } from '../src/claude-turn-state.ts';
import { markReady, saveDelivery } from '../src/mail-session.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

// remediation-20261029-native-turn-gate-holds-addressed-wakes, spec 1: source candidates for a
// stuck native turn gate, driven through the generated hook module and a real turn bridge. Each
// test asserts what the source does today. A passing "stays shut" test proves a reproducible
// source candidate only, never the historical trigger on any seat (Morgan 0e17fa27). Found:
//  (a) a native submission with no open turn: the record is busy with no turn, and idle can't open it;
//  (b) a completion for another turn id: the hook keeps its open turn and never reports idle;
//  (c) a non-answer completion: the record needs an idle observation, and one the hook ignores
//      (text in the prompt) is never re-reported. An answered completion opens the gate by itself.
// The receiver-side form of (a), a human Enter during a running turn, is in claude-turn-trace.test.ts.

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

const nonce = 'gate-candidates';
const session = 'exact';
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
let fixture: Awaited<ReturnType<typeof mailHarness>>;
let bridge: Awaited<ReturnType<typeof startClaudeTurnBridge>>;
let emit: (kind: string, event?: Metadata) => Promise<unknown>;
let draft = '';

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_NONCE = nonce;
	bridge = await startClaudeTurnBridge('alpha', nonce, session);
	await saveDelivery('alpha', {
		nonce,
		thread: session,
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
	const api: Api = {
		env: { get: (name) => Promise.resolve(bridge.env[name as keyof typeof bridge.env]) },
		session: { id: () => Promise.resolve(session) },
		prompt: { read: () => Promise.resolve({ text: draft }) },
		http: {
			fetch: async (url, init) => {
				const response = await fetch(url, init);
				return { ok: response.ok, text: await response.text() };
			},
		},
	};
	emit = async (kind, event = {}) => {
		const handler = handlers.get(kind);
		if (!handler) throw new Error(`Missing generated handler ${kind}.`);
		return handler(api, event, (input) => Promise.resolve(input));
	};
	draft = '';
	await emit('session.start');
});
afterEach(async () => {
	await bridge.stop();
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = oldNonce;
	await fixture.dispose();
});

const idlePrompt = () =>
	emit('classic.Notification', { notification_type: 'idle_prompt', session_id: session });

test('candidate (a): a native submission with no open turn, then an idle prompt', async () => {
	await emit('turn.start', { turnId: 'turn-1' });
	await emit('turn.complete', { turnId: 'turn-1', reason: 'answer', isAborted: false });
	await idlePrompt();
	const openBefore = await claudeNoticeAllowed('alpha', nonce);
	// Submitted while no turn is open: the hook reports it with turn null, and no turn.start follows.
	await emit('prompt.submit', { text: 'private fixture message' });
	await idlePrompt();
	expect(openBefore).toBe(true);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	expect((await claudeTurn('alpha', nonce))?.turn).toBeNull();
});

test('control: a matched answered turn and its idle prompt open the gate', async () => {
	await emit('turn.start', { turnId: 'turn-1' });
	await emit('turn.complete', { turnId: 'turn-1', reason: 'answer', isAborted: false });
	await idlePrompt();
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
});

test('candidate (b): a completion for another turn id leaves the hook holding its open turn', async () => {
	await emit('turn.start', { turnId: 'turn-1' });
	await emit('turn.complete', { turnId: 'turn-2', reason: 'answer', isAborted: false });
	await idlePrompt();
	// The hook still holds turn-1, so it never reports the idle prompt and the gate stays shut.
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	expect((await claudeTurn('alpha', nonce))?.turn).toBe('turn-1');
});

/**
 * An idle prompt the hook ignores: it arrives while text sits in the prompt, so the hook reports
 * nothing. The person then clears the prompt (a draft event, not an idle one) and Claude sends no
 * further idle prompt, because it sends one per idle period.
 */
async function idleIgnoredThenDraftCleared(reason: string): Promise<void> {
	await emit('turn.start', { turnId: 'turn-1' });
	await emit('turn.complete', { turnId: 'turn-1', reason, isAborted: false });
	draft = 'half-typed';
	await idlePrompt();
	draft = '';
	await emit('prompt.edit', { text: '' });
}

test('candidate (c): a non-answer completion, then an idle prompt the hook ignores, keeps the gate shut', async () => {
	await idleIgnoredThenDraftCleared('interrupted');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
});

test('candidate (c) twin: the same sequence after an answered completion', async () => {
	await idleIgnoredThenDraftCleared('answer');
	// The contrast that makes (c) specific: an answered completion opens the gate by itself, so the
	// ignored idle prompt does not matter. Only a non-answer completion depends on that idle prompt.
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
});
