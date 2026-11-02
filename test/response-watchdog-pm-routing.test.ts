import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWrite } from '../src/mail-files.ts';
import { readOwnChunk } from '../src/mail-read.ts';
import { sendMessage } from '../src/mailbox.ts';
import { evaluateResponseWatchdog } from '../src/response-watchdog.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
};
let now = 1000000;
let wall: ReturnType<typeof spyOn<typeof Date, 'now'>>;
let monotonic: ReturnType<typeof spyOn<typeof performance, 'now'>>;
const evaluate = () => evaluateResponseWatchdog('alpha', 'pm-fixture');
const register = async (name: string, pm: boolean) =>
	atomicWrite(
		join(fixture.records, `${name}.json`),
		JSON.stringify({
			...newRecord(name, fixture.root, 'codex'),
			memberType: pm ? 'pm' : 'teammate',
		}),
	);
const inbox = (name: string) => join(fixture.records, 'mailboxes', name, 'inbox');
const count = async (name: string) =>
	(await readdir(inbox(name)).catch(() => [])).filter((file) => file.endsWith('.md')).length;

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'pm-fixture';
	now = 1000000;
	wall = spyOn(Date, 'now').mockImplementation(() => now);
	monotonic = spyOn(performance, 'now').mockImplementation(() => now);
	await atomicWrite(join(fixture.records, 'runtime/alpha/pm-fixture.ready'), 'pm-fixture');
});

afterEach(async () => {
	wall.mockRestore();
	monotonic.mockRestore();
	if (previous.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous.home;
	if (previous.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previous.agent;
	if (previous.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previous.nonce;
	await fixture.dispose();
});

test('only PM roles receive alerts; multiple offline PMs each get one, and demotion prevents a clear', async () => {
	await register('coordinator', true);
	await register('planner', true);
	await register('steward', false);
	const id = await sendMessage('alpha', 'alpha', 'work');
	await evaluate();
	now += 600000;
	await evaluate();
	await evaluate();
	expect(await count('coordinator')).toBe(1);
	expect(await count('planner')).toBe(1);
	expect(await count('steward')).toBe(0);
	await register('planner', false);
	await readOwnChunk('alpha', id, 0, 32768);
	await evaluate();
	expect(await count('coordinator')).toBe(2);
	expect(await count('planner')).toBe(1);
	expect(await count('steward')).toBe(0);
});

test('an ongoing alert waits for a PM registration; PM owners do not escalate to each other', async () => {
	await sendMessage('alpha', 'alpha', 'work');
	await evaluate();
	now += 600000;
	await evaluate();
	await register('coordinator', true);
	await evaluate();
	expect(await count('coordinator')).toBe(1);
	await register('alpha', true);
	await register('planner', true);
	process.env.SUMMON_NONCE = 'new-pm-launch';
	await evaluateResponseWatchdog('alpha', 'new-pm-launch');
	now += 600000;
	await evaluateResponseWatchdog('alpha', 'new-pm-launch');
	expect(await count('coordinator')).toBe(2); // Ends the previous teammate launch only.
	expect(await count('planner')).toBe(0);
});

test('a crash after publishing the clear replays the exact archived message without duplication', async () => {
	await register('coordinator', true);
	const id = await sendMessage('alpha', 'alpha', 'work');
	await evaluate();
	now += 600000;
	await evaluate();
	const path = join(fixture.records, 'runtime/alpha/response-watchdog-relay.json');
	const retained = JSON.parse(await readFile(path, 'utf8')) as {
		resolution: null | { text: string };
	};
	await readOwnChunk('alpha', id, 0, 32768);
	await evaluate();
	const files = await readdir(inbox('coordinator'));
	for (const file of files.filter((file) => file.endsWith('.md'))) {
		const content = await readFile(join(inbox('coordinator'), file), 'utf8');
		if (!content.includes('episode has resolved')) continue;
		retained.resolution = {
			text: content.split('\n\n').slice(1).join('\n\n').trim(),
		};
		const archive = join(fixture.records, 'mailboxes/coordinator/archive', file);
		await atomicWrite(archive, content);
		await rename(join(inbox('coordinator'), file), archive);
	}
	expect(retained.resolution).not.toBeNull();
	await atomicWrite(path, JSON.stringify(retained));
	await evaluate();
	expect(await count('coordinator')).toBe(1); // Only the original alert remains in the inbox.
	expect(await readFile(path, 'utf8')).toBe('null');
});

test('a replacement launch defers its resolution while owner observation is suspended', async () => {
	await register('coordinator', true);
	await sendMessage('alpha', 'alpha', 'work');
	await evaluate();
	now += 600000;
	await evaluate();
	await atomicWrite(
		join(fixture.records, 'alpha.json'),
		JSON.stringify({
			...newRecord('alpha', fixture.root, 'codex'),
			hibernation: { active: true, revision: crypto.randomUUID(), changedAt: now },
		}),
	);
	process.env.SUMMON_NONCE = 'replacement';
	await evaluateResponseWatchdog('alpha', 'replacement');
	expect(await count('coordinator')).toBe(1);
	await register('alpha', false);
	await evaluateResponseWatchdog('alpha', 'replacement');
	expect(await count('coordinator')).toBe(2);
});

test('malformed recipient paths fail closed before looking up a registration', async () => {
	await register('coordinator', true);
	await sendMessage('alpha', 'alpha', 'work');
	await evaluate();
	now += 600000;
	await evaluate();
	const path = join(fixture.records, 'runtime/alpha/response-watchdog-relay.json');
	const retained = JSON.parse(await readFile(path, 'utf8')) as {
		recipients: { name: string; sent: boolean }[];
	};
	for (const recipient of retained.recipients) {
		recipient.name = '../coordinator';
		recipient.sent = false;
	}
	await atomicWrite(path, JSON.stringify(retained));
	expect(await evaluate().catch((error: unknown) => error)).toBeInstanceOf(Error);
	expect(await count('coordinator')).toBe(1);
});

test('multiple PMs receive distinct mail identities and both read receipts reach the owner', async () => {
	await register('coordinator', true);
	await register('planner', true);
	const work = await sendMessage('alpha', 'alpha', 'work');
	await evaluate();
	now += 600000;
	await evaluate();
	const ids: string[] = [];
	for (const name of ['coordinator', 'planner']) {
		const [file] = (await readdir(inbox(name))).filter((file) => file.endsWith('.md'));
		if (!file) throw new Error('Missing PM alert');
		ids.push(file.slice(0, -3));
		process.env.SUMMON_AGENT = name;
		await readOwnChunk(name, file.slice(0, -3), 0, 32768);
	}
	process.env.SUMMON_AGENT = 'alpha';
	expect(await count('alpha')).toBe(3);
	expect(new Set(ids).size).toBe(2);
	await readOwnChunk('alpha', work, 0, 32768);
	await evaluate();
	for (const name of ['coordinator', 'planner']) {
		const [file] = (await readdir(inbox(name))).filter(
			(file) => file.endsWith('.md') && !ids.includes(file.slice(0, -3)),
		);
		if (!file) throw new Error('Missing PM resolution');
		ids.push(file.slice(0, -3));
		process.env.SUMMON_AGENT = name;
		await readOwnChunk(name, file.slice(0, -3), 0, 32768);
	}
	process.env.SUMMON_AGENT = 'alpha';
	const receipts = await Promise.all(
		(await readdir(inbox('alpha')))
			.filter((file) => file.endsWith('.md'))
			.map((file) => readFile(join(inbox('alpha'), file), 'utf8')),
	);
	for (const id of ids)
		expect(
			receipts.filter(
				(text) => text.includes('Kind: receipt\n') && text.includes(`In-Reply-To: ${id}\n`),
			),
		).toHaveLength(1);
	expect(new Set(ids).size).toBe(4);
});

test('invalid and name-mismatched registrations cannot receive PM alerts or hide a healthy PM', async () => {
	await register('coordinator', true);
	await atomicWrite(join(fixture.records, 'broken.json'), '{broken');
	await atomicWrite(
		join(fixture.records, 'backup.json'),
		JSON.stringify({ ...newRecord('coordinator', fixture.root, 'codex'), memberType: 'pm' }),
	);
	await sendMessage('alpha', 'alpha', 'work');
	await evaluate();
	now += 600000;
	await evaluate();
	expect(await count('coordinator')).toBe(1);
	expect(await count('broken')).toBe(0);
	expect(await count('backup')).toBe(0);
});
