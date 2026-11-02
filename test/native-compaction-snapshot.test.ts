import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';

import type { TeamAgent } from '../src/desktop/types.ts';

import { initializeActivity } from '../src/agent-activity.ts';
import {
	initializeClaudeTurn,
	invalidateClaudeTurn,
	observeClaudeTurn,
} from '../src/claude-turn-state.ts';
import { memberStateLabel } from '../src/desktop/member-identity.ts';
import { teamSnapshot } from '../src/desktop/team-snapshot.ts';
import * as models from '../src/provider-model-info.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const oldHome = process.env.SUMMON_HOME;
const nonce = 'compaction-launch';
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	await fixture.dispose();
});

test('authenticated nested compactions enter and leave the exact owned snapshot', async () => {
	const model = spyOn(models, 'refreshModelInfo').mockResolvedValue(undefined);
	const agent: TeamAgent = {
		slug: 'alpha',
		name: 'Alpha',
		provider: 'claude',
		cwd: fixture.root,
		status: 'running',
	};
	const context = {
		sessions: new Map([
			['alpha', { agent, launch: { nonce, since: new Date().toISOString() } }],
		]),
		reported: new Set<string>(),
		emit: () => {},
		startedAt: new Date().toISOString(),
		selected: 'alpha',
	};
	const row = async () =>
		(await teamSnapshot(context)).agents.find((value) => value.slug === 'alpha');
	let sequence = 0;
	const event = async (kind: 'attach' | 'start' | 'compact-start' | 'compact-end') =>
		observeClaudeTurn('alpha', nonce, 'observer', {
			session: 'thread',
			epoch: 1,
			sequence: ++sequence,
			kind,
			turn: kind === 'start' ? 'turn' : null,
			draft: false,
			completed: false,
		});
	try {
		await initializeActivity('alpha', nonce, 'claude');
		await initializeClaudeTurn('alpha', nonce, 'thread', 'observer');
		await event('attach');
		await event('start');
		expect((await row())?.nativeCompacting).toBeUndefined();
		await event('compact-start');
		await event('compact-start');
		expect((await row())?.nativeCompacting).toBe(true);
		const value = await row();
		if (!value) throw new Error('Missing owned snapshot.');
		expect(memberStateLabel(value)).toBe('Compacting…');
		await event('compact-end');
		expect((await row())?.nativeCompacting).toBe(true);
		await event('compact-end');
		expect((await row())?.nativeCompacting).toBeUndefined();
		await event('compact-start');
		await initializeActivity('alpha', 'other-launch', 'claude');
		expect((await row())?.nativeCompacting).toBeUndefined();
		await initializeActivity('alpha', nonce, 'claude');
		expect((await row())?.nativeCompacting).toBe(true);
		await invalidateClaudeTurn('alpha', nonce, 'observer');
		expect((await row())?.nativeCompacting).toBeUndefined();
		await Bun.write(join(fixture.records, `runtime/alpha/${nonce}.claude-turn`), '{');
		// An unreadable record drops only the mark; the row stays whole and Stop asks (0.31.1).
		const unreadable = await row();
		expect(unreadable?.observationUnavailable).toBeUndefined();
		expect(unreadable?.providerTurn).toBe('unknown');
		expect(unreadable?.nativeCompacting).toBeUndefined();
	} finally {
		model.mockRestore();
	}
});
