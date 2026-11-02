import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cloneAgent } from '../src/clone.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { localCursorPath } from '../src/room-cursor.ts';
import { acquireSessionLock } from '../src/session-lock.ts';
import { loadAgent, newRecord, saveAgent } from '../src/store.ts';
import { saveProfile, type TeamProfile } from '../src/team-maintenance.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let other: ReturnType<typeof Bun.spawn> | undefined;
const previous = { home: process.env.SUMMON_HOME, agent: process.env.SUMMON_AGENT };
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	// Creating a member is an operator action.
	delete process.env.SUMMON_AGENT;
	for (const text of ['one', 'two', 'three'])
		await appendLocalEvent({
			sender: { kind: 'user', id: 'operator' },
			text,
			replyTo: null,
			source: 'local',
		});
});
afterEach(async () => {
	other?.kill();
	await other?.exited;
	other = undefined;
	if (previous.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous.home;
	if (previous.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previous.agent;
	await fixture.dispose();
});

/**
 * A registration deleted by hand while its session still runs: another live process holds the
 * name's session lock, and its cursor sits at 1.
 */
async function liveOldSession(slug: string): Promise<void> {
	other = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 60000)']);
	await Bun.sleep(300);
	const lock = join(fixture.records, 'runtime', slug, 'session.lock');
	await mkdir(lock, { recursive: true });
	await writeFile(
		join(lock, 'owner.json'),
		JSON.stringify({ pid: other.pid, nonce: randomUUID() }),
	);
	await writeFile(localCursorPath(slug), '1');
}

async function refusal(work: Promise<unknown>): Promise<string> {
	return work.then(
		() => '',
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
}

const addDelta = (): TeamProfile => ({
	memberType: 'teammate',
	canStopResting: false,
	displayName: 'delta',
	name: 'delta',
	provider: 'codex',
	cwd: fixture.root,
	expertise: 'Testing',
	domain: 'Fixtures',
	backup: '',
	notes: '',
	notesRevision: null,
	profileRevision: null,
	sessionId: '',
});
test('a clone onto a name with a live old session is refused before any cursor write', async () => {
	await saveAgent('source', newRecord('Source', fixture.root, 'claude'));
	await liveOldSession('delta');
	expect(await refusal(cloneAgent('Source', 'Delta'))).toContain(
		'A session is still running under the name Delta',
	);
	expect(await readFile(localCursorPath('delta'), 'utf8')).toBe('1');
	expect(await loadAgent('delta')).toBeUndefined();
});

test('an empty-ID Team Maintenance add onto a live old session is refused before any cursor write', async () => {
	await liveOldSession('delta');
	expect(await refusal(saveProfile(addDelta(), null))).toContain(
		'A session is still running under the name delta',
	);
	expect(await readFile(localCursorPath('delta'), 'utf8')).toBe('1');
	expect(await loadAgent('delta')).toBeUndefined();
});

test('once the old session has ended, the same clone registers with a fresh cursor', async () => {
	await saveAgent('source', newRecord('Source', fixture.root, 'claude'));
	await liveOldSession('delta');
	other?.kill();
	await other?.exited;
	other = undefined;
	expect((await cloneAgent('Source', 'Delta')).slug).toBe('delta');
	// The old cursor at 1 is replaced by the start of today, before all three of today's posts.
	expect(await readFile(localCursorPath('delta'), 'utf8')).toBe('0');
});

test('a malformed owner under the name fails closed for clone and for a Maintenance add', async () => {
	await saveAgent('source', newRecord('Source', fixture.root, 'claude'));
	const lock = join(fixture.records, 'runtime', 'delta', 'session.lock');
	await mkdir(lock, { recursive: true });
	await writeFile(join(lock, 'owner.json'), '{"pid":"not a pid"}');
	await writeFile(localCursorPath('delta'), '1');
	expect(await refusal(cloneAgent('Source', 'Delta'))).toContain('Invalid session lock');
	expect(await refusal(saveProfile(addDelta(), null))).toContain('Invalid session lock');
	expect(await readFile(localCursorPath('delta'), 'utf8')).toBe('1');
	expect(await loadAgent('delta')).toBeUndefined();
});

test('a refused clone or Maintenance add releases the name lock it took', async () => {
	await saveAgent('source', newRecord('Source', fixture.root, 'claude'));
	await mkdir(join(fixture.records, 'runtime', 'delta'), { recursive: true });
	await writeFile(join(fixture.records, 'runtime', 'delta', 'checkpoint.json'), '{}');
	for (const work of [() => cloneAgent('Source', 'Delta'), () => saveProfile(addDelta(), null)]) {
		expect(await refusal(work())).toContain('Checkpoint state from an earlier delta remains');
		const next = await acquireSessionLock('delta');
		expect(next).toBeDefined();
		await next?.release();
	}
	expect(await loadAgent('delta')).toBeUndefined();
});
