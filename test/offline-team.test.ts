import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertOfflineTeamFiles } from '../src/offline-team.ts';

// Roger #57762 High 2: the schedule migration must refuse a live or unverifiable runtime lease.
let root = '';
let target = '';
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-offline-team-'));
	target = join(root, 'schedules', 'state.json');
	await mkdir(join(root, 'schedules'), { recursive: true });
	await writeFile(target, '{}');
	await mkdir(join(root, 'runtime', 'alpha'), { recursive: true });
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
const refusal = (promise: Promise<void>) =>
	promise.then(
		() => '',
		(error: unknown) => String(error),
	);

test('a runtime with only ended leases passes', async () => {
	// A PID that cannot be a live process, recorded as an ended session's heartbeat.
	await writeFile(
		join(root, 'runtime', 'alpha', 'session-heartbeat.json'),
		JSON.stringify({ pid: 2147483646, at: 1 }),
	);
	expect(await refusal(assertOfflineTeamFiles(root, target))).toBe('');
});

test('a lease held by a live process refuses the migration', async () => {
	// This test process started before the record was written, so it is the live owner.
	await writeFile(
		join(root, 'runtime', 'alpha', 'session-heartbeat.json'),
		JSON.stringify({ pid: process.pid, at: Date.now() }),
	);
	expect(await refusal(assertOfflineTeamFiles(root, target))).toContain('migration refused');
});

test('an unreadable receiver owner refuses the migration', async () => {
	await mkdir(join(root, 'runtime', 'alpha', 'receiver'));
	await writeFile(join(root, 'runtime', 'alpha', 'receiver', 'owner.json'), 'not an owner');
	expect(await refusal(assertOfflineTeamFiles(root, target))).toContain('migration refused');
});
