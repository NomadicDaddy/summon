import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { communicationState, setCommunicationPause } from '../src/communication-state.ts';
import { recoverMissedMentionWakes } from '../src/desktop/mention-recovery.ts';
import { Team } from '../src/desktop/team.ts';
import { appendLocalEvent, localEvents } from '../src/local-room.ts';
import { answerRoom } from '../src/room-question-access.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return '';
	} catch (error: unknown) {
		return String(error);
	}
}
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});

test('human card answer wakes its requester and survives recovery without textual mentions', async () => {
	await writeFile(
		join(fixture.records, 'alpha.json'),
		JSON.stringify(newRecord('alpha', fixture.root, 'grok')),
	);
	await fixture.run(['--room', 'ask', '--approval', 'Approve?'], 'alpha');
	const answer = await answerRoom(1, 0);
	const starts: string[] = [];
	const team = new Team(
		'bun',
		'fixture.ts',
		() => {},
		() => {
			throw new Error('Unexpected process launch');
		},
	);
	team.start = (name) => {
		starts.push(name);
		return Promise.resolve();
	};
	await team.wakeMentions(answer);
	expect(starts).toEqual(['alpha']);
	starts.length = 0;
	await recoverMissedMentionWakes(
		await localEvents(),
		'2000-01-01T00:00:00Z',
		() => false,
		(name) => {
			starts.push(name);
			return Promise.resolve();
		},
	);
	expect(starts).toEqual(['alpha']);
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

test('approval CLI persists exact choices; concurrent human answers are idempotent and conflicting decisions rejected', async () => {
	const sent = await fixture.run(
		['--room', 'ask', '--approval', 'Approve fixture action?'],
		'alpha',
	);
	expect(sent.code).toBe(0);
	const q = (await localEvents())[0];
	if (!q) throw new Error(`Question missing: ${sent.error}`);
	expect(q.question).toEqual({ kind: 'approval', choices: ['Yes', 'No'], allowFreeform: false });
	const answers = await Promise.all([answerRoom(q.id, 0), answerRoom(q.id, 0)]);
	expect(answers[0].id).toBe(answers[1].id);
	expect(answers[0].sender.kind).toBe('user');
	expect(answers[0].replyTo).toBe(q.id);
	expect(await failure(answerRoom(q.id, 1))).toContain('already been answered');
	expect(await failure(answerRoom(q.id, null, 'Maybe'))).toBeTruthy();
	expect(await localEvents()).toHaveLength(2);
	const read = await fixture.run(['--room', 'read', '0'], 'alpha');
	expect(read.out).toContain('"questionId":1');
});

test('custom choices and freeform preserve context without interpreting control text; pause blocks agent asks', async () => {
	expect(
		(await fixture.run(['--room', 'ask', 'Which?', '--choice', 'A', '--choice', 'B'], 'alpha'))
			.code,
	).toBe(0);
	await setCommunicationPause(true);
	const answer = await answerRoom(1, null, 'proceed');
	expect(answer.text).toBe('proceed');
	expect((await communicationState()).paused).toBe(true);
	expect((await fixture.run(['--room', 'ask', 'Another?'], 'alpha')).code).not.toBe(0);
	expect(
		await failure(
			appendLocalEvent({
				sender: { kind: 'agent', id: 'alpha' },
				text: 'A',
				source: 'local',
				replyTo: 1,
				answer: { questionId: 1, choice: 0 },
			}),
		),
	).toBeTruthy();
});

test('invalid choice definitions and forged human answer through agent access fail without writing', async () => {
	for (const args of [
		['Q', '--no-freeform'],
		['Q', '--choice', 'A', '--choice', 'A'],
		['--approval', 'Q', '--choice', 'Other'],
		['Q', '--choice', 'x'.repeat(121)],
	]) {
		expect((await fixture.run(['--room', 'ask', ...args], 'alpha')).code).not.toBe(0);
	}
	expect(await localEvents()).toHaveLength(0);
	await fixture.run(['--room', 'ask', 'Q', '--choice', 'A', '--no-freeform'], 'alpha');
	expect(await failure(answerRoom(1, 3))).toBeTruthy();
	expect(await failure(answerRoom(1, null, 'Free'))).toBeTruthy();
	const old = process.env.SUMMON_AGENT;
	process.env.SUMMON_AGENT = 'alpha';
	try {
		expect(await failure(answerRoom(1, 0))).toBeTruthy();
	} finally {
		if (old === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = old;
	}
});
