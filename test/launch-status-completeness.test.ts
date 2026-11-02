import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import * as identity from '../src/checkpoint-offline-runtime.ts';
import { readLaunchStatus } from '../src/launch-status.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { terminalHarness } from './fixtures/owned-terminal.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previousHome = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previousHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousHome;
	await fixture.dispose();
});

test('unreadable activity and missing registration never publish a complete empty launch list', async () => {
	const h = terminalHarness();
	const control = spyOn(identity, 'processStart').mockResolvedValue(Date.now() - 1000);
	try {
		await h.team.start('alpha', false);
		const launch = h.team.sessions.get('alpha')?.launch;
		if (!launch) throw new Error('Missing owned fixture.');
		await initializeActivity('alpha', launch.nonce, 'claude');
		await h.team.snapshot();
		expect(await readLaunchStatus()).toMatchObject({
			current: true,
			members: [{ slug: 'alpha', launch: { phase: 'connecting' } }],
		});
		const activityPath = join(fixture.records, 'runtime/alpha/activity.json');
		const activity = await readFile(activityPath, 'utf8');
		await writeFile(activityPath, '{');
		await h.team.snapshot();
		expect((await readLaunchStatus()).current).toBe(false);
		await writeFile(activityPath, activity);
		await h.team.snapshot();
		expect((await readLaunchStatus()).current).toBe(true);
		const recordPath = join(fixture.records, 'alpha.json');
		const record = await readFile(recordPath, 'utf8');
		await rm(recordPath);
		await h.team.snapshot();
		expect((await readLaunchStatus()).current).toBe(false);
		await writeFile(recordPath, record);
		await h.team.snapshot();
		expect((await readLaunchStatus()).current).toBe(true);
	} finally {
		control.mockRestore();
	}
});

test('a previously healthy empty view becomes unavailable when its running owner cannot be read', async () => {
	const h = terminalHarness();
	const control = spyOn(identity, 'processStart').mockResolvedValue(Date.now() - 1000);
	try {
		await h.team.start('alpha', false);
		const launch = h.team.sessions.get('alpha')?.launch;
		if (!launch) throw new Error('Missing owned fixture.');
		await initializeActivity('alpha', launch.nonce, 'claude');
		const activityPath = join(fixture.records, 'runtime/alpha/activity.json');
		await writeFile(
			activityPath,
			JSON.stringify({
				nonce: launch.nonce,
				state: 'idle',
				workingOn: 'Ready',
				updatedAt: new Date().toISOString(),
			}),
		);
		await h.team.snapshot();
		expect(await readLaunchStatus()).toMatchObject({ current: true, members: [] });
		await writeFile(activityPath, '{');
		await h.team.snapshot();
		expect((await readLaunchStatus()).current).toBe(false);
		// An intentionally ended owned session is excluded, so its bad record cannot
		// turn an otherwise complete empty view into an unavailable live launch.
		const session = h.team.sessions.get('alpha');
		if (!session) throw new Error('Missing owned fixture.');
		session.agent.status = 'stopped';
		await h.team.snapshot();
		expect(await readLaunchStatus()).toMatchObject({ current: true, members: [] });
	} finally {
		control.mockRestore();
	}
});
