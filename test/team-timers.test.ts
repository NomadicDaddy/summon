import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';

import type { MentionScanDiagnostic } from '../src/desktop/mention-scan-metrics.ts';
import type { TeamEvent } from '../src/desktop/types.ts';

import { createBoardItem } from '../src/board.ts';
import { setCommunicationPause } from '../src/communication-state.ts';
import { createTeamTimers } from '../src/desktop/team-timers.ts';
import { Team } from '../src/desktop/team.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { initialMentionCursor, saveMentionCursor } from '../src/team-mentions.ts';
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

function harness() {
	const sent: TeamEvent[] = [];
	const diagnostics: MentionScanDiagnostic[] = [];
	const team = new Team(
		'bun',
		'cli.ts',
		(event) => sent.push(event),
		() => {
			throw new Error('Unexpected provider launch');
		},
	);
	let halted = false;
	let canSend = true;
	const timers = createTeamTimers({
		team,
		send: (event) => sent.push(event),
		canSend: () => canSend,
		halted: () => halted,
		initialCursor: 0,
		previousTeamStart: null,
		onMentionDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
	});
	return {
		team,
		timers,
		sent,
		diagnostics,
		halt: () => {
			halted = true;
		},
		allowSend: (value: boolean) => {
			canSend = value;
		},
	};
}
const post = () =>
	appendLocalEvent({
		sender: { kind: 'user', id: 'operator' },
		text: 'Fixture room event',
		replyTo: null,
		source: 'local',
	});

test('mention polling persists each event cursor and recovers only once', async () => {
	const h = harness();
	await post();
	await post();
	await saveMentionCursor(0);
	const recovered = spyOn(h.team, 'recoverMissedMentionWakes').mockResolvedValue();
	const seen: number[] = [];
	const wake = spyOn(h.team, 'wakeMentions').mockImplementation(async () => {
		seen.push(await initialMentionCursor());
	});
	try {
		await h.timers.scanMentions();
		expect(seen).toEqual([0, 1]);
		expect(await initialMentionCursor()).toBe(2);
		const firstScan = h.diagnostics[0];
		if (firstScan?.kind !== 'scan') throw new Error('Missing first scan diagnostic');
		expect(firstScan.outcome).toBe('complete');
		for (const stage of [
			'hibernation',
			'communication',
			'schedules',
			'rest',
			'recovery',
			'events',
			'settings',
			'wake',
			'cursor',
			'flush',
		] as const)
			expect(firstScan.stagesMs).toHaveProperty(stage);
		await h.timers.scanMentions();
		expect(seen).toEqual([0, 1]);
		expect(recovered).toHaveBeenCalledTimes(1);
	} finally {
		wake.mockRestore();
		recovered.mockRestore();
		await h.timers.stop();
	}
});

test('paused communication leaves the cursor unchanged and does not wake', async () => {
	const h = harness();
	await post();
	await saveMentionCursor(0);
	await setCommunicationPause(true);
	const wake = spyOn(h.team, 'wakeMentions').mockResolvedValue();
	try {
		await h.timers.scanMentions();
		expect(await initialMentionCursor()).toBe(0);
		expect(wake).not.toHaveBeenCalled();
		expect(h.diagnostics).toMatchObject([{ kind: 'scan', outcome: 'paused', skippedTicks: 0 }]);
	} finally {
		wake.mockRestore();
		await h.timers.stop();
	}
});

test('overlapping scans are excluded and stop waits for the current scan', async () => {
	const h = harness();
	await setCommunicationPause(true);
	const entered = Promise.withResolvers<undefined>();
	const release = Promise.withResolvers<undefined>();
	const sync = spyOn(h.team, 'syncHibernation').mockImplementation(async () => {
		entered.resolve(undefined);
		await release.promise;
	});
	const scan = h.timers.scanMentions();
	await entered.promise;
	await h.timers.scanMentions();
	expect(sync).toHaveBeenCalledTimes(1);
	expect(h.diagnostics).toMatchObject([
		{ kind: 'overlap', activeStage: 'hibernation', skippedTicks: 1 },
	]);
	let stopped = false;
	const stopping = h.timers.stop().then(() => {
		stopped = true;
	});
	await Promise.resolve();
	expect(stopped).toBe(false);
	release.resolve(undefined);
	await Promise.all([scan, stopping]);
	expect(stopped).toBe(true);
	expect(h.diagnostics).toMatchObject([
		{ kind: 'overlap', skippedTicks: 1 },
		{ kind: 'scan', outcome: 'paused', skippedTicks: 1 },
	]);
	const completed = h.diagnostics[1];
	if (completed?.kind !== 'scan') throw new Error('Missing completed scan diagnostic');
	expect(completed.stagesMs).toHaveProperty('hibernation');
	expect(completed.stagesMs).toHaveProperty('communication');
	await h.timers.scanMentions();
	expect(sync).toHaveBeenCalledTimes(1);
	sync.mockRestore();
});

test('roster and Board polling deduplicate changes and respect readiness and halt', async () => {
	const h = harness();
	const snapshot = spyOn(h.team, 'snapshot').mockResolvedValue({ agents: [], selected: '' });
	try {
		h.allowSend(false);
		await h.timers.checkRoster();
		await h.timers.checkBoard();
		expect(h.sent).toEqual([]);
		h.allowSend(true);
		await h.timers.checkRoster();
		await h.timers.checkBoard();
		await h.timers.checkRoster();
		await h.timers.checkBoard();
		expect(h.sent.map((event) => event.type)).toEqual(['snapshot', 'board']);
		snapshot.mockResolvedValue({ agents: [], selected: 'alpha' });
		await createBoardItem({ title: 'Fixture task', owner: 'alpha' });
		await h.timers.checkRoster();
		await h.timers.checkBoard();
		expect(h.sent.map((event) => event.type)).toEqual([
			'snapshot',
			'board',
			'snapshot',
			'board',
		]);
		h.halt();
		await h.timers.checkRoster();
		await h.timers.checkBoard();
		expect(h.sent).toHaveLength(4);
	} finally {
		snapshot.mockRestore();
		await h.timers.stop();
	}
});
