import { expect, test } from 'bun:test';
import { join } from 'node:path';

import {
	claudeNoticeAllowed,
	claudeTurn,
	initializeClaudeTurn,
	observeClaudeTurn,
	reserveClaudeNotice,
} from '../src/claude-turn-state.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

test('unready startup requires attached idle and a clear draft before ordinary delivery', async () => {
	const fixture = await mailHarness();
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = fixture.records;
	try {
		const nonce = 'startup-gate';
		await initializeClaudeTurn('alpha', nonce, 'thread', 'observer');
		let sequence = 0;
		const event = (kind: string, turn: string | null, draft = false, completed = false) =>
			observeClaudeTurn('alpha', nonce, 'observer', {
				session: 'thread',
				epoch: 1,
				sequence: ++sequence,
				kind,
				turn,
				draft,
				completed,
			});
		expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
		expect(reserveClaudeNotice('alpha', nonce)).rejects.toThrow('verified turn');
		await event('attach', null);
		await event('start', 'startup', true);
		expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
		await event('complete', 'startup', true, true);
		expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
		await event('draft', null);
		// Readiness need not be acknowledged: the native completion alone releases delivery.
		expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
		await event('compact-start', null);
		expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
		await event('compact-end', null);
		expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
		await event('end', null);
		expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await fixture.dispose();
	}
});

test('old launch state is refused unchanged while a fresh nonce initializes independently', async () => {
	const fixture = await mailHarness();
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = fixture.records;
	try {
		await initializeClaudeTurn('alpha', 'old-launch', 'thread', 'observer');
		const oldPath = join(fixture.records, 'runtime/alpha/old-launch.claude-turn');
		const oldBytes = JSON.stringify({
			...(await claudeTurn('alpha', 'old-launch')),
			version: 1,
			bootstrapUsed: false,
		});
		await Bun.write(oldPath, oldBytes);
		expect(claudeNoticeAllowed('alpha', 'old-launch')).rejects.toThrow('Invalid Claude turn');
		expect(initializeClaudeTurn('alpha', 'old-launch', 'thread', 'observer')).rejects.toThrow(
			'Invalid Claude turn',
		);
		await initializeClaudeTurn('alpha', 'new-launch', 'thread', 'observer');
		expect(await claudeNoticeAllowed('alpha', 'new-launch')).toBe(false);
		expect((await claudeTurn('alpha', 'new-launch'))?.version).toBe(2);
		expect(await Bun.file(oldPath).text()).toBe(oldBytes);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await fixture.dispose();
	}
});
