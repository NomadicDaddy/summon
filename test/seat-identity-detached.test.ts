import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { appendLocalEvent, localEvents, localRoomPath } from '../src/local-room.ts';
import { locked } from '../src/mail-files.ts';
import { mailboxPath, sendMessage } from '../src/mailbox.ts';
import { scrubSummonEnvironment } from '../src/unowned-command.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const originalRoot = process.env.SUMMON_HOME;
const originalAgent = process.env.SUMMON_AGENT;
const originalNonce = process.env.SUMMON_NONCE;

async function waitForLockCandidate(path: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const entries = await readdir(dirname(path)).catch(() => [] as string[]);
		if (
			entries.some(
				(entry) => entry.startsWith(`${basename(path)}.`) && entry.endsWith('.pending'),
			)
		)
			return;
		await Bun.sleep(10);
	}
	throw new Error('The in-flight writer did not reach its publication lock.');
}

async function holdLock(path: string): Promise<{ release: () => void; held: Promise<void> }> {
	let release = (): void => undefined;
	let entered = (): void => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const held = locked(path, async () => {
		entered();
		await gate;
	});
	await ready;
	return { release, held };
}

async function expectReplacedLaunchRefusal(operation: Promise<unknown>): Promise<void> {
	let failure: unknown;
	try {
		await operation;
	} catch (error: unknown) {
		failure = error;
	}
	expect(String(failure)).toContain('another launch');
}

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	const runtime = join(fixture.records, 'runtime', 'alpha');
	await mkdir(runtime, { recursive: true });
	await writeFile(
		join(runtime, 'activity.json'),
		JSON.stringify({
			workingOn: '',
			state: 'idle',
			updatedAt: new Date().toISOString(),
			nonce: 'replacement-launch',
		}),
	);
});

afterEach(async () => {
	if (originalRoot === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = originalRoot;
	if (originalAgent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = originalAgent;
	if (originalNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = originalNonce;
	await fixture.dispose();
});

test('in-flight Room and mail writes refuse after launch replacement', async () => {
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'test-launch';
	await initializeActivity('alpha', 'test-launch');

	const roomLock = `${localRoomPath()}.lock`;
	const roomGate = await holdLock(roomLock);
	try {
		const post = appendLocalEvent({
			sender: { kind: 'agent', id: 'alpha' },
			text: 'late Room post',
			replyTo: null,
			source: 'local',
		});
		await waitForLockCandidate(roomLock);
		await initializeActivity('alpha', 'replacement-launch');
		roomGate.release();
		await expectReplacedLaunchRefusal(post);
	} finally {
		roomGate.release();
		await roomGate.held;
	}
	const id = randomUUID();
	const mailLock = join(mailboxPath('beta'), 'acks', `${id}.lock`);
	await initializeActivity('alpha', 'test-launch');
	const mailGate = await holdLock(mailLock);
	try {
		const mail = sendMessage('alpha', 'beta', 'late mail', { id, replaySafe: true });
		await waitForLockCandidate(mailLock);
		await initializeActivity('alpha', 'replacement-launch');
		mailGate.release();
		await expectReplacedLaunchRefusal(mail);
	} finally {
		mailGate.release();
		await mailGate.held;
	}
	expect(await localEvents()).toHaveLength(0);
	expect(await readdir(join(mailboxPath('beta'), 'inbox'))).not.toContain(`${id}.md`);
});

test('a replaced launch cannot post to Room or send mail as its former seat', async () => {
	const staleRoom = await fixture.run(['--room', 'send', 'stale post'], 'alpha');
	expect(staleRoom.code).toBe(1);
	expect(staleRoom.error).toContain('another launch');
	const staleMail = await fixture.run(['--mail', 'send-self', 'beta', 'stale message'], 'alpha');
	expect(staleMail.code).toBe(1);
	expect(staleMail.error).toContain('another launch');
	const staleBoard = await fixture.run(['--board', 'add', 'stale card'], 'alpha');
	expect(staleBoard.code).toBe(1);
	expect(staleBoard.error).toContain('another launch');
	const staleLauncher = await fixture.run(['--unowned', '--', 'bun', '--version'], 'alpha');
	expect(staleLauncher.code).toBe(1);
	expect(staleLauncher.error).toContain('another launch');
	expect(await localEvents()).toHaveLength(0);

	const live = { SUMMON_NONCE: 'replacement-launch' };
	expect((await fixture.run(['--room', 'send', 'live post'], 'alpha', live)).code).toBe(0);
	expect(
		(await fixture.run(['--mail', 'send-self', 'beta', 'live message'], 'alpha', live)).code,
	).toBe(0);
	expect((await localEvents()).map((event) => event.text)).toEqual(['live post']);
});

test('a missing activity record refuses named commands', async () => {
	await rm(join(fixture.records, 'runtime/alpha/activity.json'));
	const result = await fixture.run(['--room', 'send', 'unowned post'], 'alpha');
	expect(result.code).toBe(1);
	expect(result.error).toContain('another launch');
	expect(await localEvents()).toHaveLength(0);
});

test('unowned launch strips every seat variable from child and descendant', async () => {
	expect(
		scrubSummonEnvironment({
			SUMMON_AGENT: 'alpha',
			sUmMoN_nonce: 'old',
			SUMMON_CLAUDE_TURN_KEY: 'not-a-real-key',
			KEEP_SETTING: 'kept',
		}),
	).toEqual({ KEEP_SETTING: 'kept' });
	const child = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, '../src/cli.ts'),
			'--unowned',
			'--',
			process.execPath,
			join(import.meta.dir, 'fixtures/unowned-observe.ts'),
		],
		{
			cwd: fixture.root,
			env: {
				...process.env,
				SUMMON_HOME: fixture.records,
				SUMMON_AGENT: 'alpha',
				SUMMON_NONCE: 'replacement-launch',
				SUMMON_CLAUDE_TURN_URL: 'http://invalid.example',
				SUMMON_CLAUDE_TURN_KEY: 'not-a-real-key',
				KEEP_SETTING: 'kept',
			},
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		},
	);
	const [out, error, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(error).toBe('');
	expect(code).toBe(0);
	const observed: unknown = JSON.parse(out);
	expect(observed).toEqual({ direct: [], descendant: [], keep: 'kept' });
});

test('ordinary operator Room path remains available', async () => {
	expect((await fixture.run(['--msg', 'operator post'])).code).toBe(0);
	expect((await localEvents()).map((event) => event.text)).toEqual(['operator post']);
});
