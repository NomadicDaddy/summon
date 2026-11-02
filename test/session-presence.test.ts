import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	parsePs,
	type ProcessFacts,
	resolvePresence,
	sessionHostFor,
	snapshotFor,
} from '../src/session-presence.ts';

let root: string;
const previous = process.env.SUMMON_HOME;
const lockedAt = Date.parse('2026-10-23T14:00:00Z');
const before = lockedAt - 1000;
const hostCommand =
	'C:\\Tools\\bun\\bun.exe D:\\applications\\summon\\src\\cli.ts __session ada --storage-root C:\\s';
const owner = { pid: 101, nonce: '91ad8d1a-0eee-46c8-96e5-2660b4c4dc66', childPid: 202 };

/** A healthy Team Window session: window 10 hosts bun 101, which hosts claude 202. */
const live: Record<number, ProcessFacts> = {
	10: { name: 'electron.exe', startedAt: before - 5000 },
	101: { name: 'bun.exe', parentPid: 10, startedAt: before, commandLine: hostCommand },
	202: { name: 'claude.exe', parentPid: 101, startedAt: before + 500 },
};

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-presence-'));
	process.env.SUMMON_HOME = root;
});

afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await rm(root, { recursive: true, force: true });
});

async function lock(slug: string, value: unknown): Promise<void> {
	const dir = join(root, 'runtime', slug, 'session.lock');
	await mkdir(dir, { recursive: true });
	const path = join(dir, 'owner.json');
	await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
	await utimes(path, new Date(lockedAt), new Date(lockedAt));
}

/**
 * A fake snapshot: the asked PIDs and, as the real one does, their parents. Like a real one it
 * always sees the calling process; `blind` drops that, as a sandboxed caller's snapshot would.
 */
const snapshotOf =
	(facts: Record<number, ProcessFacts>, blind = false) =>
	(pids: number[]) => {
		const found = new Map<number, ProcessFacts>();
		const add = (pid: number | undefined) => {
			const fact = pid === undefined ? undefined : facts[pid];
			if (pid !== undefined && fact) found.set(pid, fact);
		};
		for (const pid of pids) add(pid);
		for (const fact of [...found.values()]) add(fact.parentPid);
		if (!blind && pids.includes(process.pid)) found.set(process.pid, { name: 'bun.exe' });
		return Promise.resolve(found);
	};

/** A copy without one key, for the 'this detail could not be read' fixtures. */
function without<T extends object>(value: T, key: keyof T): T {
	return Object.fromEntries(Object.entries(value).filter(([name]) => name !== String(key))) as T;
}

/** The operating system's answer for PIDs a snapshot omits: none of the fixture PIDs exist. */
const gone = () => false;

async function one(facts: Record<number, ProcessFacts>, provider = 'claude') {
	return (await resolvePresence([{ slug: 'ada', provider }], snapshotOf(facts), gone)).get('ada');
}

test('a live session host that predates its lock, with its window and provider, is online', async () => {
	await lock('ada', owner);
	const presence = await one(live);
	expect(presence).toMatchObject({
		state: 'online',
		reason: 'running in the Summon Team Window',
	});
	expect(Number.isFinite(Date.parse(presence?.observedAt ?? ''))).toBe(true);
	expect(JSON.stringify(presence)).not.toContain('__session');
});

test('no lock, or a lock whose owner and provider have ended, is offline', async () => {
	expect((await one({}))?.state).toBe('offline');
	await lock('ada', owner);
	expect(await one({})).toMatchObject({ state: 'offline', reason: 'the lock owner has ended' });
});

test('a reused PID is never online', async () => {
	await lock('ada', owner);
	const newer = { ...live[101], startedAt: lockedAt + 5000 };
	expect((await one({ 10: live[10] as ProcessFacts, 101: newer }))?.state).toBe('offline');
	expect((await one({ ...live, 101: newer }))?.state).toBe('unknown');
	// Host gone: a provider PID taken by a newer process is offline; a genuine orphan is unknown.
	const reusedChild = { name: 'notepad.exe', parentPid: 10, startedAt: lockedAt + 5000 };
	expect((await one({ 10: live[10] as ProcessFacts, 202: reusedChild }))?.state).toBe('offline');
	expect(
		(await one({ 10: live[10] as ProcessFacts, 202: live[202] as ProcessFacts }))?.state,
	).toBe('unknown');
});

test('inaccessible process details are unknown, never online', async () => {
	await lock('ada', owner);
	const host = live[101] as ProcessFacts;
	expect((await one({ ...live, 101: without(host, 'startedAt') }))?.state).toBe('unknown');
	expect((await one({ ...live, 101: without(host, 'commandLine') }))?.state).toBe('unknown');
	const failing = () => Promise.reject(new Error('access denied'));
	expect(
		(await resolvePresence([{ slug: 'ada', provider: 'claude' }], failing)).get('ada')?.state,
	).toBe('unknown');
});

test('a changed identity holding the PID, a lost window or a missing provider is unknown', async () => {
	await lock('ada', owner);
	const notepad = {
		name: 'notepad.exe',
		parentPid: 10,
		startedAt: before,
		commandLine: 'notepad.exe',
	};
	expect((await one({ ...live, 101: notepad }))?.state).toBe('unknown');
	const sibling = {
		...live[101],
		commandLine: hostCommand.replace('__session ada', '__session bob'),
	};
	expect((await one({ ...live, 101: sibling }))?.state).toBe('unknown');
	expect((await one(without(live, 10)))?.state).toBe('unknown');
	expect((await one(without(live, 202)))?.state).toBe('unknown');
	expect((await one(live, 'codex'))?.state).toBe('unknown');
});

test('a malformed lock is unknown, and stale activity elsewhere proves nothing', async () => {
	await lock('ada', '{not json');
	await writeFile(
		join(root, 'runtime', 'ada', 'activity.json'),
		JSON.stringify({ state: 'busy' }),
	);
	expect((await one(live))?.state).toBe('unknown');
	await rm(join(root, 'runtime', 'ada', 'session.lock'), { recursive: true });
	expect((await one(live))?.state).toBe('offline');
});

test('every member in a report is judged from one process snapshot', async () => {
	await lock('ada', owner);
	await lock('bob', { pid: 303, nonce: owner.nonce });
	const calls: number[][] = [];
	const inner = snapshotOf(live);
	const snapshot = async (pids: number[]) => {
		calls.push([...pids]);
		return inner(pids);
	};
	const members = ['ada', 'bob', 'cy'].map((slug) => ({ slug, provider: 'claude' }));
	const result = await resolvePresence(members, snapshot, gone);
	expect(calls).toHaveLength(1);
	// The lock PIDs, plus the caller itself as the snapshot's own positive control.
	expect(calls[0]?.sort((a, b) => a - b)).toEqual(
		[101, 202, 303, process.pid].sort((a, b) => a - b),
	);
	expect([...result].map(([slug, p]) => [slug, p.state])).toEqual([
		['ada', 'online'],
		['bob', 'offline'],
		['cy', 'offline'],
	]);
});

test('a snapshot that cannot see its own caller is unreadable, so held locks are unknown', async () => {
	// The live case: a sandboxed sender whose snapshot sees no other process at all. Before this,
	// every held lock read as "the lock owner has ended" and was reported definitely offline.
	await lock('ada', owner);
	await lock('bob', { pid: 303, nonce: owner.nonce });
	const members = ['ada', 'bob', 'cy'].map((slug) => ({ slug, provider: 'claude' }));
	const blind = await resolvePresence(members, snapshotOf({}, true), gone);
	expect([...blind].map(([slug, p]) => [slug, p.state])).toEqual([
		['ada', 'unknown'],
		['bob', 'unknown'],
		// No lock at all is a filesystem fact, not a process one, so it stays offline.
		['cy', 'offline'],
	]);
	// The same live facts, blind to the caller, decide nothing either.
	expect((await resolvePresence(members, snapshotOf(live, true), gone)).get('ada')?.state).toBe(
		'unknown',
	);
});

test('a held owner the snapshot omits is offline only if the system says its PID is gone', async () => {
	// Partly blind: the snapshot sees the caller but not bob's still-running host, PID 303.
	await lock('bob', { pid: 303, nonce: owner.nonce, childPid: 404 });
	const members = [{ slug: 'bob', provider: 'claude' }];
	const exists = (alive: number[]) => (pid: number) => alive.includes(pid);
	const verdict = async (alive: number[]) =>
		(await resolvePresence(members, snapshotOf({}), exists(alive))).get('bob');
	expect((await verdict([303]))?.state).toBe('unknown');
	expect((await verdict([404]))?.state).toBe('unknown');
	expect((await verdict([303]))?.reason).toBe(
		'the lock owner still exists but the process snapshot did not show it',
	);
	expect(await verdict([])).toMatchObject({
		state: 'offline',
		reason: 'the lock owner has ended',
	});
});

test('the session host is Bun or Node running __session for exactly that member', () => {
	const bun = { name: 'bun.exe', commandLine: hostCommand };
	expect(sessionHostFor(bun, 'ada')).toBe(true);
	expect(sessionHostFor({ name: 'node', commandLine: 'node cli.js __session ada' }, 'ada')).toBe(
		true,
	);
	expect(sessionHostFor({ ...bun, name: 'claude.exe' }, 'ada')).toBe(false);
	expect(sessionHostFor({ ...bun, commandLine: 'bun cli.ts __session adam' }, 'ada')).toBe(false);
	expect(sessionHostFor({ ...bun, commandLine: 'bun cli.ts --presence ada' }, 'ada')).toBe(false);
	expect(
		sessionHostFor(
			{ name: 'bun.exe', commandLine: '"C:\\a b\\bun.exe" "D:\\x y\\cli.ts" __session ada' },
			'ada',
		),
	).toBe(true);
});

test('macOS and Linux ps rows give the same facts, with the start placed at its earliest second', () => {
	const now = Date.parse('2026-10-23T15:00:00.400Z');
	const facts = parsePs(
		[
			'  4100     1 1-02:03:04 /usr/bin/zsh -l',
			'  4200  4100      05:06 /usr/local/bin/bun /repo/src/cli.ts __session ada --storage-root /s',
			'  4300  4200   12:00:00 /usr/local/bin/claude --resume x',
			'garbage line',
		].join('\n'),
		now,
	);
	expect([...facts.keys()]).toEqual([4100, 4200, 4300]);
	const host = facts.get(4200);
	expect(host).toMatchObject({ name: 'bun', parentPid: 4100 });
	expect(sessionHostFor(host as ProcessFacts, 'ada')).toBe(true);
	// 5:06 elapsed at 15:00:00.4 means a start in (14:54:53.4, 14:54:54.4]; the floor is 14:54:53.
	expect(host?.startedAt).toBe(Date.parse('2026-10-23T14:54:53.000Z'));
	expect(facts.get(4100)?.startedAt).toBe(now - 400 - (93784 + 1) * 1000);
	expect(facts.get(4300)?.name).toBe('claude');
});

test('macOS and Linux get the ps snapshot, not the Windows one that would see no processes', () => {
	expect(snapshotFor('linux')).toBe(snapshotFor('darwin'));
	expect(snapshotFor('linux')).not.toBe(snapshotFor('win32'));
});
