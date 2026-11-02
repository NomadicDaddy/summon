import { afterEach, beforeEach, expect, test } from 'bun:test';

import { initializeActivity } from '../src/agent-activity.ts';
import { tickRest } from '../src/desktop/rest.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { readRest, refreshRest, stopForRest } from '../src/rest.ts';
import { addressedTo } from '../src/room-wake.ts';
import { loadAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { presence, presenceTeam } from './fixtures/presence-groups.ts';

// A rest-stopped seat resumes through the rest tick, not the mention loop, so the group rule
// must hold there too: an agent's group post may not start it (Morgan, mail 9fa039c6).

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeActivity('alpha', 'test-launch');
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

async function stopAlphaForRest(): Promise<void> {
	const record = await loadAgent('alpha');
	if (!record) throw new Error('Missing fixture member');
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
	const ready = await readRest('alpha');
	if (!ready) throw new Error('Missing rest confirmation');
	await stopForRest('alpha', ready.id, () => Promise.resolve(), record.provider);
	expect((await readRest('alpha'))?.mode).toBe('stopped');
}

function post(kind: 'agent' | 'user', text: string) {
	return appendLocalEvent(
		{
			sender: kind === 'agent' ? { kind, id: 'roger' } : { kind, id: 'operator' },
			text,
			replyTo: null,
			source: 'local',
		},
		presence({ alpha: 'offline', beta: 'online' }).resolve,
	);
}

test("an agent's offline-group post neither resumes nor starts a rest-stopped seat", async () => {
	await stopAlphaForRest();
	const event = await post('agent', 'Notes on @offline for whoever is away.');
	expect(event.groups?.offline).toContain('alpha');
	// Still addressed, so a running member's rest would end; only the stopped start is refused.
	expect(addressedTo(event, 'alpha')).toBe(true);
	expect((await refreshRest('alpha'))?.mode).toBe('stopped');
	const h = presenceTeam();
	await h.team.wakeMentions(event);
	await tickRest(h.team);
	await tickRest(h.team);
	expect(h.launched()).toBe(0);
	expect((await readRest('alpha'))?.mode).toBe('stopped');
	await h.close();
});

test.each([
	{
		who: 'a human offline-group post',
		kind: 'user' as const,
		text: 'Please check in, @offline.',
	},
	{
		who: "an agent's explicit name",
		kind: 'agent' as const,
		text: '@alpha your review, please.',
	},
])('$who still resumes a rest-stopped seat', async ({ kind, text }) => {
	await stopAlphaForRest();
	await post(kind, text);
	const state = await refreshRest('alpha');
	expect(state?.mode).toBe('wake-requested');
	expect(state?.resume).toBe(true);
	const h = presenceTeam();
	await tickRest(h.team);
	expect(h.launched()).toBe(1);
	await h.close();
});
