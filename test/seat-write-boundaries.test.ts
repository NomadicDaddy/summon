import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { addBoardComment, createBoardItem, readBoard } from '../src/board.ts';
import { addDiary, readDiary } from '../src/diary.ts';
import { locked } from '../src/mail-files.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const prior = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
};

async function waitForCandidate(path: string): Promise<void> {
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
	throw new Error('Writer did not reach the held publication lock.');
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

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'test-launch';
});

afterEach(async () => {
	if (prior.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = prior.home;
	if (prior.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = prior.agent;
	if (prior.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = prior.nonce;
	await fixture.dispose();
});

test('in-flight Board mutation and comment refuse after launch replacement', async () => {
	const boardLock = join(fixture.records, 'board', 'state.json.lock');
	const first = await holdLock(boardLock);
	try {
		const add = createBoardItem({ title: 'Late card' });
		await waitForCandidate(boardLock);
		await initializeActivity('alpha', 'replacement-launch');
		first.release();
		let failure: unknown;
		try {
			await add;
		} catch (error: unknown) {
			failure = error;
		}
		expect(String(failure)).toContain('another launch');
	} finally {
		first.release();
		await first.held;
	}
	expect((await readBoard()).items).toHaveLength(0);
	await initializeActivity('alpha', 'test-launch');
	const card = (await createBoardItem({ title: 'Existing card' })).items[0];
	if (!card) throw new Error('Missing fixture card.');
	const second = await holdLock(boardLock);
	try {
		const comment = addBoardComment(card.id, 'Late comment');
		await waitForCandidate(boardLock);
		await initializeActivity('alpha', 'replacement-launch');
		second.release();
		let failure: unknown;
		try {
			await comment;
		} catch (error: unknown) {
			failure = error;
		}
		expect(String(failure)).toContain('another launch');
	} finally {
		second.release();
		await second.held;
	}
	expect((await readBoard()).items[0]?.comments).toHaveLength(0);
});

test('in-flight Diary entry refuses after launch replacement', async () => {
	const path = join(fixture.records, 'diary', 'entries.json.lock');
	const gate = await holdLock(path);
	try {
		const add = addDiary({ for: 'Phillip', task: 'Late entry' });
		await waitForCandidate(path);
		await initializeActivity('alpha', 'replacement-launch');
		gate.release();
		let failure: unknown;
		try {
			await add;
		} catch (error: unknown) {
			failure = error;
		}
		expect(String(failure)).toContain('another launch');
	} finally {
		gate.release();
		await gate.held;
	}
	expect((await readDiary()).entries).toHaveLength(0);
});

test('in-flight Notes edit refuses after launch replacement', async () => {
	const path = join(fixture.records, 'alpha.md');
	await writeFile(path, 'original notes');
	const lock = `${path}.lock`;
	const gate = await holdLock(lock);
	try {
		const revision = createHash('sha256').update('original notes').digest('hex');
		const child = Bun.spawn(
			[process.execPath, join(import.meta.dir, '../src/cli.ts'), '--notes', 'write'],
			{
				env: {
					...process.env,
					SUMMON_HOME: fixture.records,
					SUMMON_AGENT: 'alpha',
					SUMMON_NONCE: 'test-launch',
				},
				stdin: new Blob([JSON.stringify({ revision, text: 'late notes' })]),
				stdout: 'pipe',
				stderr: 'pipe',
				windowsHide: true,
			},
		);
		await waitForCandidate(lock);
		await initializeActivity('alpha', 'replacement-launch');
		gate.release();
		const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(code).toBe(1);
		expect(error).toContain('another launch');
	} finally {
		gate.release();
		await gate.held;
	}
	expect(await readFile(path, 'utf8')).toBe('original notes');
});
