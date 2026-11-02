import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import * as identity from '../src/checkpoint-offline-runtime.ts';
import { Team, type TerminalProcess } from '../src/desktop/team.ts';
import { readLaunchStatus } from '../src/launch-status.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { runtimeFaultRejection as rejection } from './fixtures/runtime-fault-test.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const oldHome = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	await fixture.dispose();
});

function ownedFixture() {
	let launches = 0;
	let stops = 0;
	let exit: (value: { exitCode: number }) => void = () => {};
	const pty: TerminalProcess = {
		pid: process.pid,
		onData: () => ({ dispose: () => {} }),
		onExit: (listener) => {
			exit = listener;
			return { dispose: () => {} };
		},
		write: () => {},
		resize: () => {},
		kill: () => exit({ exitCode: 0 }),
	};
	const team = new Team(
		'bun',
		'cli.ts',
		() => {},
		() => {
			launches++;
			return pty;
		},
		() => {
			stops++;
			exit({ exitCode: 0 });
			return Promise.resolve();
		},
	);
	return { team, launches: () => launches, stops: () => stops };
}

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const) {
	for (const failure of ['activity', 'registration-invalid', 'registration-missing'] as const) {
		test(`${provider}: ${failure} preserves its real owned row, select, stop and unavailable evidence`, async () => {
			const h = ownedFixture();
			const control = spyOn(identity, 'processStart').mockResolvedValue(Date.now() - 1000);
			try {
				const registration = join(fixture.records, 'alpha.json');
				await writeFile(
					registration,
					JSON.stringify(newRecord('alpha', fixture.root, provider)),
				);
				await h.team.start('alpha', false);
				const session = h.team.sessions.get('alpha');
				if (!session) throw new Error('Missing owned fixture.');
				await initializeActivity('alpha', session.launch.nonce, provider);
				expect(
					(await h.team.snapshot()).agents.find((row) => row.slug === 'alpha'),
				).toMatchObject({
					status: 'running',
					ownedSession: true,
					launch: { phase: 'connecting' },
				});
				expect((await readLaunchStatus()).current).toBe(true);
				const path =
					failure === 'activity'
						? join(fixture.records, 'runtime/alpha/activity.json')
						: registration;
				const original = await readFile(path, 'utf8');
				if (failure === 'registration-missing') await rm(path);
				else await writeFile(path, '{');
				const row = (await h.team.snapshot()).agents.find(
					(member) => member.slug === 'alpha',
				);
				expect(row).toMatchObject({
					slug: 'alpha',
					name: session.agent.name,
					provider,
					cwd: session.agent.cwd,
					status: 'running',
					ownedSession: true,
					observationUnavailable: true,
				});
				expect(row?.launch).toBeUndefined();
				expect(row?.activity).toBeUndefined();
				expect(row?.workingOn).toBeUndefined();
				expect(row?.restConfirmation).toBeUndefined();
				expect(await readLaunchStatus()).toMatchObject({ current: false, members: [] });
				await h.team.select('alpha');
				expect(h.team.selected).toBe('alpha');
				expect(h.launches()).toBe(1);
				expect(
					failure === 'registration-missing'
						? await Bun.file(path).exists()
						: await readFile(path, 'utf8'),
				).toBe(failure === 'registration-missing' ? false : '{');
				await writeFile(path, original);
				const recovered = (await h.team.snapshot()).agents.find(
					(member) => member.slug === 'alpha',
				);
				expect(recovered?.observationUnavailable).toBeUndefined();
				expect(recovered?.launch?.phase).toBe('connecting');
				expect((await readLaunchStatus()).current).toBe(true);
				if (failure === 'registration-missing') await rm(path);
				else await writeFile(path, '{');
				await h.team.stop('alpha');
				expect(h.team.sessions.get('alpha')?.agent.status).toBe('stopped');
				expect(process.platform === 'win32' ? h.stops() : h.launches()).toBe(1);
				await h.team.snapshot();
				expect(await readLaunchStatus()).toMatchObject({ current: true, members: [] });
			} finally {
				control.mockRestore();
				await h.team.shutdown();
			}
		});
	}
}

test('missing registration never invents a non-owned session or permits a new launch', async () => {
	const h = ownedFixture();
	await rm(join(fixture.records, 'alpha.json'));
	expect((await h.team.snapshot()).agents.some((row) => row.slug === 'alpha')).toBe(false);
	expect((await rejection(h.team.select('alpha'))).message).toBe('Agent no longer exists.');
	expect((await rejection(h.team.start('alpha'))).message).toBe('Agent no longer exists.');
	expect(h.launches()).toBe(0);
});
