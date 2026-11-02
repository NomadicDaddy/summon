import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { requireExecutable } from './executable.ts';
import { missing } from './mail-files.ts';
import { runtimePath } from './mail-session.ts';
import { parseOwner, processAlive, type ProcessOwner } from './process-owner.ts';
import { isSessionHost, program } from './session-hosts.ts';

const execute = promisify(execFile);

export type PresenceState = 'online' | 'offline' | 'unknown';

/**
 * Online is claimed only from current process identity, never from activity, heartbeat, model
 * cache or registration files; anything that cannot be proven is unknown. Reasons never quote a
 * command line, which can carry a session prompt.
 */
export interface Presence {
	state: PresenceState;
	reason: string;
	observedAt: string;
}

/** What one process snapshot says about a PID. An absent field means it could not be read. */
export interface ProcessFacts {
	name?: string;
	parentPid?: number;
	startedAt?: number;
	commandLine?: string;
}

/** Facts for the PIDs asked about and their parents; a PID missing from the result was not running. */
export type ProcessSnapshot = (pids: number[]) => Promise<Map<number, ProcessFacts>>;

type LockRead =
	| { kind: 'none' }
	| { kind: 'unreadable' }
	| { kind: 'held'; owner: ProcessOwner; writtenAt: number };

async function readLock(slug: string): Promise<LockRead> {
	const path = join(runtimePath(slug), 'session.lock', 'owner.json');
	try {
		const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
		const owner = parseOwner(text);
		return owner ? { kind: 'held', owner, writtenAt: info.mtimeMs } : { kind: 'unreadable' };
	} catch (error: unknown) {
		return missing(error) ? { kind: 'none' } : { kind: 'unreadable' };
	}
}

/** Split a Windows-style command line into arguments, honouring double quotes. */
function commandArgs(commandLine: string): string[] {
	const args: string[] = [];
	for (const match of commandLine.matchAll(/"([^"]*)"|(\S+)/g))
		args.push(match[1] ?? match[2] ?? '');
	return args;
}

/** The lock owner is Bun or Node running `__session <slug>`, the session host Summon starts. */
export function sessionHostFor(facts: ProcessFacts, slug: string): boolean {
	if (!facts.name || !['bun', 'node'].includes(program(facts.name))) return false;
	const args = commandArgs(facts.commandLine ?? '');
	const at = args.indexOf('__session');
	return at >= 0 && args[at + 1] === slug;
}

/**
 * The exact launch: the session host for `slug` started with this `--launch-nonce`. The command
 * line is only compared here, never returned or kept, so no argument leaves this function.
 */
export function sessionLaunchFor(facts: ProcessFacts, slug: string, nonce: string): boolean {
	if (!sessionHostFor(facts, slug)) return false;
	const args = commandArgs(facts.commandLine ?? '');
	const at = args.indexOf('--launch-nonce');
	return at >= 0 && args[at + 1] === nonce;
}

type Verdict = Omit<Presence, 'observedAt'>;
const unknown = (reason: string): Verdict => ({ state: 'unknown', reason });

function decide(
	slug: string,
	provider: string,
	lock: LockRead,
	facts: Map<number, ProcessFacts>,
	exists: (pid: number) => boolean,
): Verdict {
	if (lock.kind === 'none') return { state: 'offline', reason: 'no session lock' };
	if (lock.kind === 'unreadable') return unknown('the session lock could not be read');
	const { owner, writtenAt } = lock;
	const host = facts.get(owner.pid);
	const child = owner.childPid === undefined ? undefined : facts.get(owner.childPid);
	if (!host && !child) {
		// Absent from the snapshot is not proof of an exit: a snapshot can omit a live process.
		// Offline needs the operating system to say neither PID exists.
		const live = [owner.pid, owner.childPid].some((pid) => pid !== undefined && exists(pid));
		return live
			? unknown('the lock owner still exists but the process snapshot did not show it')
			: { state: 'offline', reason: 'the lock owner has ended' };
	}
	if (!host) {
		if (child?.startedAt === undefined)
			return unknown("the provider's start time could not be read");
		if (child.startedAt > writtenAt)
			return {
				state: 'offline',
				reason: "the lock owner has ended and the provider's PID now belongs to a newer process",
			};
		return unknown('the provider is running without its session host');
	}
	if (host.startedAt === undefined)
		return unknown("the lock owner's start time could not be read");
	if (host.startedAt > writtenAt) {
		if (!child || (child.startedAt !== undefined && child.startedAt > writtenAt))
			return {
				state: 'offline',
				reason: "the lock owner's PID now belongs to a newer process",
			};
		return unknown("the lock owner's PID was reused while its provider still runs");
	}
	if (host.commandLine === undefined || host.name === undefined)
		return unknown("the lock owner's details could not be read");
	if (!sessionHostFor(host, slug))
		return unknown(`the lock owner is not ${slug}'s Summon session`);
	const parent = host.parentPid === undefined ? undefined : facts.get(host.parentPid);
	if (!parent?.name) return unknown("the session's window or terminal is not running");
	if (!isSessionHost(parent.name))
		return unknown("the session's parent is not a terminal or the Team Window");
	if (!child || child.parentPid !== owner.pid || program(child.name ?? '') !== provider)
		return unknown(`the session host is running but its ${provider} process is not`);
	return {
		state: 'online',
		reason:
			program(parent.name) === 'electron'
				? 'running in the Summon Team Window'
				: 'running in a terminal',
	};
}

/** One process query for the whole report (wanted PIDs, then their parents), so every member is judged from the same moment. */
const windowsSnapshot: ProcessSnapshot = async (pids) => {
	const result = new Map<number, ProcessFacts>();
	const wanted = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
	if (!wanted.length) return result;
	const script = [
		`$found = @(Get-CimInstance Win32_Process -Filter '${wanted.map((pid) => `ProcessId=${pid}`).join(' OR ')}')`,
		`$parents = @($found | ForEach-Object { $_.ParentProcessId } | Where-Object { $_ -gt 0 } | Select-Object -Unique)`,
		`if ($parents.Count) { $found += @(Get-CimInstance Win32_Process -Filter (($parents | ForEach-Object { "ProcessId=$_" }) -join ' OR ')) }`,
		`@($found | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; started = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() } else { $null }; command = $_.CommandLine } }) | ConvertTo-Json -Compress -AsArray`,
	].join('; ');
	const { stdout } = await execute(
		requireExecutable('pwsh'),
		['-NoProfile', '-NonInteractive', '-Command', script],
		{ windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
	);
	const rows: unknown = JSON.parse(stdout.trim() || '[]');
	for (const row of Array.isArray(rows) ? rows : []) {
		const value = row as Record<string, unknown>;
		if (!Number.isSafeInteger(value.pid)) continue;
		result.set(Number(value.pid), {
			...(typeof value.name === 'string' && value.name ? { name: value.name } : {}),
			...(Number.isSafeInteger(value.ppid) ? { parentPid: Number(value.ppid) } : {}),
			...(Number.isSafeInteger(value.started) ? { startedAt: Number(value.started) } : {}),
			...(typeof value.command === 'string' && value.command
				? { commandLine: value.command }
				: {}),
		});
	}
	return result;
};

/** A `ps` elapsed time, `[[dd-]hh:]mm:ss`, in milliseconds. */
function elapsedMs(text: string): number | undefined {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
	if (!match) return undefined;
	const [, days, hours, minutes, seconds] = match;
	const total = ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60;
	return (total + Number(seconds)) * 1000;
}

/**
 * Rows of `ps -o pid=,ppid=,etime=,args=`. `ps` reports whole seconds, so the start is placed at
 * the earliest moment it could have been: a live session is never mistaken for a reused PID, at
 * the cost of missing a reuse within the same second.
 */
export function parsePs(stdout: string, now: number): Map<number, ProcessFacts> {
	const result = new Map<number, ProcessFacts>();
	for (const line of stdout.split('\n')) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
		if (!match) continue;
		const [, pid = '', ppid = '', elapsed = '', commandLine = ''] = match;
		const age = elapsedMs(elapsed);
		const first = commandArgs(commandLine)[0] ?? '';
		result.set(Number(pid), {
			name: first.split(/[\\/]/).at(-1) ?? first,
			parentPid: Number(ppid),
			...(age === undefined
				? {}
				: { startedAt: Math.floor((now - age) / 1000) * 1000 - 1000 }),
			commandLine,
		});
	}
	return result;
}

/** macOS and Linux: the same two-step snapshot through `ps`; a PID it doesn't list has ended. */
const posixSnapshot: ProcessSnapshot = async (pids) => {
	const list = async (wanted: number[]): Promise<Map<number, ProcessFacts>> => {
		if (!wanted.length) return new Map();
		const args = ['-o', 'pid=,ppid=,etime=,args=', '-p', wanted.join(',')];
		const now = Date.now();
		try {
			return parsePs(
				(await execute('ps', args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })).stdout,
				now,
			);
		} catch (error: unknown) {
			// ps exits 1 when some asked PIDs are gone; what it did print is still the answer.
			const stdout = (error as { stdout?: unknown }).stdout;
			if ((error as { code?: unknown }).code === 1 && typeof stdout === 'string')
				return parsePs(stdout, now);
			throw error;
		}
	};
	const wanted = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
	const found = await list(wanted);
	const parents = [...new Set([...found.values()].map((fact) => fact.parentPid ?? 0))].filter(
		(pid) => pid > 0 && !found.has(pid),
	);
	for (const [pid, fact] of await list(parents)) found.set(pid, fact);
	return found;
};

/** The process snapshot for a platform: Windows through CIM, everything else through `ps`. */
export function snapshotFor(platform: NodeJS.Platform): ProcessSnapshot {
	return platform === 'win32' ? windowsSnapshot : posixSnapshot;
}

/**
 * Presence for each member (slug and saved provider) from its session lock and one shared snapshot.
 * `exists` is the operating system's own answer for a PID the snapshot omitted.
 */
export async function resolvePresence(
	members: { slug: string; provider: string }[],
	snapshot: ProcessSnapshot = snapshotFor(process.platform),
	exists: (pid: number) => boolean = processAlive,
): Promise<Map<string, Presence>> {
	const locks = await Promise.all(
		members.map(async (m) => ({ ...m, lock: await readLock(m.slug) })),
	);
	const pids = locks.flatMap(({ lock }) =>
		lock.kind === 'held'
			? [lock.owner.pid, ...(lock.owner.childPid === undefined ? [] : [lock.owner.childPid])]
			: [],
	);
	let facts: Map<number, ProcessFacts> | undefined;
	try {
		// The snapshot must see this very process too. A sandboxed caller (Codex runs commands
		// in one) can get a snapshot that sees no other process, and every held lock would then
		// look abandoned: definitely offline. Without the caller, nothing in it is evidence.
		facts = pids.length ? await snapshot([...pids, process.pid]) : new Map();
		if (pids.length && !facts.has(process.pid)) facts = undefined;
	} catch {
		facts = undefined;
	}
	const observedAt = new Date().toISOString();
	const presence = new Map<string, Presence>();
	for (const { slug, provider, lock } of locks) {
		const verdict =
			!facts && lock.kind === 'held'
				? unknown('process details could not be read')
				: decide(slug, provider, lock, facts ?? new Map<number, ProcessFacts>(), exists);
		presence.set(slug, { ...verdict, observedAt });
	}
	return presence;
}
