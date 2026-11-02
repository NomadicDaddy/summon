import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { queueCodex } from '../src/codex-mail-delivery.ts';
import { CodexQueueError } from '../src/codex-queue-failures.ts';
import { requireExecutable } from '../src/executable.ts';
import { NotificationNotSentError } from '../src/notification-delivery.ts';

// Synthetic sentinels only; no real credential or provider queue is touched.
const SECRET = 'SYNTHETIC-SENTINEL-sk-0000';
const realSpawn = Bun.spawn;
const previousPath = process.env.PATH;
let bin = '';
let script = '';
let launches = 0;

beforeEach(async () => {
	bin = await mkdtemp(join(tmpdir(), 'summon-queue-'));
	await writeFile(join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex'), '', {
		mode: 0o700,
	});
	process.env.PATH = bin;
	launches = 0;
	Bun.spawn = ((options: { cmd: string[]; stdout: 'ignore'; stderr: 'pipe' }) => {
		expect(options.cmd.slice(0, 3)).toEqual([requireExecutable('codex'), 'queue', '--thread']);
		expect(options.stdout).toBe('ignore');
		expect(options.stderr).toBe('pipe');
		launches++;
		return realSpawn({ ...options, cmd: [process.execPath, '-e', script], windowsHide: true });
	}) as typeof Bun.spawn;
});
afterEach(async () => {
	Bun.spawn = realSpawn;
	if (previousPath === undefined) delete process.env.PATH;
	else process.env.PATH = previousPath;
	// Any descendant a test started is ended here, so none outlives the test.
	const pid = Number(await readFile(join(bin, 'descendant.pid'), 'utf8').catch(() => 'NaN'));
	if (Number.isFinite(pid)) {
		try {
			process.kill(pid);
		} catch {
			/* already gone */
		}
	}
	await rm(bin, { recursive: true, force: true });
});

/** A child whose detached descendant inherits stderr and holds it for 6 s. */
function withHeldStderr(tail: string): string {
	const pidFile = join(bin, 'descendant.pid');
	const descendant = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stderr.write('held');setTimeout(()=>{},6000)`;
	return `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','inherit'],detached:true}).unref(); ${tail}`;
}

async function failure(text = 'notice', timeoutMs?: number): Promise<unknown> {
	return queueCodex('fixture-thread', text, timeoutMs).then(
		() => undefined,
		(error: unknown) => error,
	);
}

test('an exit failure carries only a fixed label; provider output and the message stay out', async () => {
	script = `process.stderr.write(${JSON.stringify(`token ${SECRET}\nnotice MESSAGE-BODY-SENTINEL\n`)}); process.exit(3);`;
	const error = await failure('MESSAGE-BODY-SENTINEL');
	expect(error).toBeInstanceOf(CodexQueueError);
	expect(error).not.toBeInstanceOf(NotificationNotSentError);
	expect(String(error)).toBe(
		'CodexQueueError: Codex queue failed (exit 3); check the provider session.',
	);
	// Every own field, including message, stack and any cause.
	const fields = JSON.stringify(error, Object.getOwnPropertyNames(error));
	expect(fields).not.toContain(SECRET);
	expect(fields).not.toContain('MESSAGE-BODY-SENTINEL');
	expect((error as CodexQueueError).failureClass).toBe('unclassified');
	expect((error as CodexQueueError).exitCode).toBe(3);
});

test('each allowlisted Codex queue error maps to its label, even split across UTF-8 chunks', async () => {
	const cases: [string, string][] = [
		[
			'cannot queue through an embedded app server while a local app-server daemon is running; remove',
			'embedded-server-conflict',
		],
		['failed to open queue db at C:/x', 'queue-db-unavailable'],
		['--no-daemon cannot be used with codex queue. Queuing must', 'no-daemon-flag'],
	];
	for (const [text, label] of cases) {
		// A multi-byte character split between writes precedes the literal.
		script = `const b=Buffer.from(${JSON.stringify(`é ${text}`)}); process.stderr.write(b.subarray(0,1)); setTimeout(()=>{process.stderr.write(b.subarray(1), () => process.exit(1));},20);`;
		expect(((await failure()) as CodexQueueError).failureClass).toBe(label as never);
	}
});

test('large provider output is drained to the end without blocking the child', async () => {
	script = `process.stderr.write('x'.repeat(4*1024*1024), () => process.exit(0));`;
	expect(await failure()).toBeUndefined();
	script = `process.stderr.write('y'.repeat(4*1024*1024) + 'failed to open queue db at', () => process.exit(5));`;
	const error = (await failure()) as CodexQueueError;
	// The literal lies past the retained prefix, so it is honestly unclassified.
	expect([error.exitCode, error.failureClass]).toEqual([5, 'unclassified']);
});

test('a hung queue is killed and reported as a timeout, never as a refusal', async () => {
	script = `process.stderr.write('failed to open queue db at'); setTimeout(()=>{},10000);`;
	const error = (await failure('notice', 300)) as CodexQueueError;
	expect(error).toBeInstanceOf(CodexQueueError);
	expect([error.outcome, error.exitCode, error.failureClass]).toEqual([
		'timeout',
		null,
		'unclassified',
	]);
	expect(error).not.toBeInstanceOf(NotificationNotSentError);
});

// Morticia L1 on 25af291: a detached descendant holding stderr made a 300 ms exit 0 wait 6 s and
// report a timeout (controls/l1-probe-output-4.json).
test('a descendant holding stderr cannot turn a successful queue into a late timeout', async () => {
	script = withHeldStderr('setTimeout(()=>process.exit(0),300);');
	const started = Date.now();
	expect(await failure('notice', 3000)).toBeUndefined();
	expect(Date.now() - started).toBeLessThan(2000);
});

test('a descendant holding stderr cannot hold a killed queue past its timer', async () => {
	script = withHeldStderr('setInterval(()=>{},1000);');
	const started = Date.now();
	const error = (await failure('notice', 800)) as CodexQueueError;
	expect(error.outcome).toBe('timeout');
	expect(Date.now() - started).toBeLessThan(2500);
});

// startup-readiness-race (2026-10-25): a drain that failed while the exit was awaited became an
// unhandled rejection and ended the whole session with exit 1. It must reach this caller instead.
test('a drain that fails while the exit is awaited reaches the caller, not the process', async () => {
	const unhandled: unknown[] = [];
	const record = (reason: unknown) => unhandled.push(reason);
	process.on('unhandledRejection', record);
	try {
		Bun.spawn = (() => {
			launches++;
			return {
				stderr: undefined,
				exited: new Promise((done) => setTimeout(() => done(0), 200)),
				kill: () => undefined,
			};
		}) as unknown as typeof Bun.spawn;
		const error = await failure('notice', 3000);
		await Bun.sleep(50);
		expect(error).toBeInstanceOf(TypeError);
		expect(unhandled).toEqual([]);
		expect(launches).toBe(1);
	} finally {
		process.off('unhandledRejection', record);
	}
});

test('a missing executable stays certain; a spawn failure stays uncertain', async () => {
	script = 'process.exit(0)';
	process.env.PATH = '';
	expect(await failure()).toBeInstanceOf(NotificationNotSentError);
	process.env.PATH = bin;
	Bun.spawn = () => {
		throw new Error(`spawn refused ${SECRET}`);
	};
	const error = await failure();
	expect(error).toBeInstanceOf(CodexQueueError);
	expect(error).not.toBeInstanceOf(NotificationNotSentError);
	expect((error as CodexQueueError).outcome).toBe('spawn-failed');
	expect(String(error)).not.toContain(SECRET);
	expect(await queueCodex('--', 'notice').catch((e: unknown) => e)).toBeInstanceOf(
		NotificationNotSentError,
	);
	expect(launches).toBe(0);
});

test('success reports nothing', async () => {
	script = 'process.exit(0)';
	expect(await failure()).toBeUndefined();
	expect(launches).toBe(1);
});

test('a final source refusal never starts the unwithdrawable native queue', async () => {
	script = 'process.exit(0)';
	const error: unknown = await queueCodex('fixture-thread', 'notice', 3000, () =>
		Promise.resolve(false),
	).catch((value: unknown) => value);
	expect(error).toBeInstanceOf(NotificationNotSentError);
	expect(launches).toBe(0);
});

test('a still-current notice is revalidated before queue input', async () => {
	script = 'process.exit(0)';
	let checked = false;
	await queueCodex('fixture-thread', 'notice', 3000, () => {
		expect(launches).toBe(0);
		checked = true;
		return Promise.resolve(true);
	});
	expect(checked).toBe(true);
	expect(launches).toBe(1);
});

test('a failed final source read is definitely unsent, never uncertain native input', async () => {
	const error: unknown = await queueCodex('fixture-thread', 'notice', 3000, () =>
		Promise.reject(new Error('fixture unreadable')),
	).catch((value: unknown) => value);
	expect(error).toBeInstanceOf(NotificationNotSentError);
	expect(launches).toBe(0);
});
