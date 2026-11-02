import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';

import type { TeamEvent } from '../src/desktop/types.ts';
import type { ModelInfo } from '../src/model-info.ts';

import { initializeActivity, readActivity } from '../src/agent-activity.ts';
import { Team, type TerminalProcess } from '../src/desktop/team.ts';
import * as phases from '../src/launch-phase.ts';
import { locked } from '../src/mail-files.ts';
import * as models from '../src/provider-model-info.ts';
import { newRecord, rememberSession, saveAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

async function prepared() {
	const events: TeamEvent[] = [];
	const metadata = spyOn(models, 'refreshModelInfo').mockResolvedValue(undefined);
	let exit = (): void => {};
	const pty: TerminalProcess = {
		pid: process.pid,
		onData: () => ({ dispose: () => {} }),
		onExit: (listener) => {
			exit = () => {
				listener({ exitCode: 1 });
			};
			return { dispose: () => {} };
		},
		write: () => {},
		resize: () => {},
		kill: () => exit(),
	};
	const team = new Team(
		'bun',
		'cli.ts',
		(event) => events.push(event),
		() => pty,
	);
	const record = newRecord('alpha', fixture.root, 'grok');
	rememberSession(record, 'grok-owned');
	await saveAgent('alpha', record);
	await team.start('alpha', false);
	const session = team.sessions.get('alpha');
	if (!session) throw new Error('Missing fixture session.');
	await initializeActivity('alpha', session.launch.nonce, 'grok');
	await phases.providerStarting('alpha', session.launch.nonce, 'grok-owned');
	await Bun.sleep(5);
	const info: ModelInfo = {
		provider: 'grok',
		sessionId: 'grok-owned',
		model: 'fixture-model',
		observedAt: new Date().toISOString(),
	};
	metadata.mockResolvedValue(info);
	return { team, session, events, metadata, info, exit: () => exit() };
}
const member = async (team: Team) =>
	(await team.snapshot()).agents.find((agent) => agent.slug === 'alpha');

test('positive, phase failure and recovery preserve the Grok row and report one bounded episode', async () => {
	const h = await prepared();
	const observe = spyOn(phases, 'observeGrokSession');
	try {
		expect((await member(h.team))?.launch?.phase).toBe('logging-in');
		await initializeActivity('alpha', h.session.launch.nonce, 'grok');
		await phases.providerStarting('alpha', h.session.launch.nonce, 'grok-owned');
		await Bun.sleep(5);
		h.metadata.mockResolvedValue({ ...h.info, observedAt: new Date().toISOString() });
		observe.mockRejectedValue(new Error('FIXTURE_PRIVATE_PHASE_PAYLOAD'));
		expect((await member(h.team))?.launch?.phase).toBe('connecting');
		expect((await member(h.team))?.status).toBe('running');
		const warnings = h.events.filter((event) => event.type === 'error');
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({ source: 'launch', slug: 'alpha' });
		expect(JSON.stringify(warnings)).not.toContain('FIXTURE_PRIVATE_PHASE_PAYLOAD');
		observe.mockRestore();
		expect((await member(h.team))?.launch?.phase).toBe('logging-in');
	} finally {
		observe.mockRestore();
		h.metadata.mockRestore();
	}
});

test('completed Grok startup never re-enters the phase observer', async () => {
	const h = await prepared();
	const observe = spyOn(phases, 'observeGrokSession');
	try {
		expect(
			(
				await fixture.run(['--status', 'busy', 'Actual work'], 'alpha', {
					SUMMON_NONCE: h.session.launch.nonce,
				})
			).code,
		).toBe(0);
		observe.mockRejectedValue(new Error('This observer must not be called.'));
		expect(await member(h.team)).toMatchObject({
			status: 'running',
			activity: 'busy',
			workingOn: 'Actual work',
		});
		expect(observe).not.toHaveBeenCalled();
	} finally {
		observe.mockRestore();
		h.metadata.mockRestore();
	}
});

test('Grok child exiting while its phase waits for the activity lock cannot promote it', async () => {
	const h = await prepared();
	const held = Promise.withResolvers<undefined>(),
		release = Promise.withResolvers<undefined>();
	const lock = locked(join(fixture.records, 'runtime/alpha/activity.json.lock'), async () => {
		held.resolve(undefined);
		await release.promise;
	});
	await held.promise;
	const original = phases.observeGrokSession;
	const entered = Promise.withResolvers<undefined>();
	const observe = spyOn(phases, 'observeGrokSession').mockImplementation((...args) => {
		entered.resolve(undefined);
		return original(...args);
	});
	let snapshot: Promise<unknown> | undefined;
	try {
		snapshot = h.team.snapshot();
		await entered.promise;
		h.exit();
		release.resolve(undefined);
		await lock;
		await snapshot;
		expect((await readActivity('alpha'))?.launch?.phase).toBe('connecting');
		expect(h.session.agent.status).toBe('exited');
	} finally {
		release.resolve(undefined);
		await lock;
		await snapshot;
		observe.mockRestore();
		h.metadata.mockRestore();
	}
});
