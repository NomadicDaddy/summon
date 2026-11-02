import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rmdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { locked } from '../src/mail-files.ts';
import { acquireReceiver } from '../src/mail-session.ts';
import { startMailWatcher } from '../src/mail-watcher.ts';
import { NotificationNotSentError } from '../src/notification-delivery.ts';
import { startedAfterLock } from '../src/process-start.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let previous: string | undefined;
beforeEach(async () => {
	fixture = await mailHarness();
	previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

async function deadPid(): Promise<number> {
	const child = Bun.spawn({
		cmd: [process.execPath, '-e', 'process.exit(0)'],
		windowsHide: true,
	});
	await child.exited;
	return child.pid;
}

test('one receiver wins, including competing takeover after an owner crashes', async () => {
	const release = await acquireReceiver('beta', 'first');
	expect(release).toBeDefined();
	expect(await acquireReceiver('beta', 'second')).toBeUndefined();
	await release?.();
	const path = join(fixture.records, 'runtime/beta/receiver');
	await mkdir(path);
	await writeFile(
		join(path, 'owner.json'),
		JSON.stringify({ pid: await deadPid(), nonce: randomUUID() }),
	);
	const old = new Date(Date.now() - 60000);
	await utimes(join(path, 'owner.json'), old, old);
	const contenders = await Promise.all([
		acquireReceiver('beta', 'next-a'),
		acquireReceiver('beta', 'next-b'),
	]);
	expect(contenders.filter(Boolean)).toHaveLength(1);
	for (const cleanup of contenders) await cleanup?.();
});

test('old ownerless locks recover while recent incomplete leases remain protected', async () => {
	const root = join(fixture.records, 'runtime/beta');
	await mkdir(root, { recursive: true });
	const path = join(root, 'orphan.lock');
	await writeFile(path, '');
	const old = new Date(Date.now() - 60000);
	await utimes(path, old, old);
	expect(await locked(path, () => Promise.resolve('recovered'))).toBe('recovered');
	const lease = join(root, 'receiver');
	await mkdir(lease);
	expect(await acquireReceiver('beta', 'early')).toBeUndefined();
	await utimes(lease, old, old);
	const winners = await Promise.all([
		acquireReceiver('beta', 'one'),
		acquireReceiver('beta', 'two'),
	]);
	expect(winners.filter(Boolean)).toHaveLength(1);
	for (const release of winners) await release?.();
});

test.skipIf(process.platform !== 'win32')(
	'a reused live PID cannot retain an older receiver lease',
	async () => {
		const path = join(fixture.records, 'runtime/beta/receiver');
		await mkdir(path, { recursive: true });
		const ownerPath = join(path, 'owner.json');
		await writeFile(ownerPath, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
		const old = new Date('2000-01-01T00:00:00Z');
		await utimes(ownerPath, old, old);
		expect(await startedAfterLock(process.pid, old.getTime())).toBe(true);
		const contenders = await Promise.all([
			acquireReceiver('beta', 'replacement-a'),
			acquireReceiver('beta', 'replacement-b'),
		]);
		try {
			expect(contenders.filter(Boolean)).toHaveLength(1);
			expect(await acquireReceiver('beta', 'third')).toBeUndefined();
		} finally {
			for (const release of contenders) await release?.();
		}
	},
	15000,
);

test('a recovered send restores unconfirmed delivery', async () => {
	const previousAgent = process.env.SUMMON_AGENT;
	const previousNonce = process.env.SUMMON_NONCE;
	process.env.SUMMON_AGENT = 'beta';
	process.env.SUMMON_NONCE = 'test-launch';
	let calls = 0;
	const stop = await startMailWatcher('beta', 'test-launch', () => {
		calls += 1;
		if (calls === 1) throw new NotificationNotSentError('temporary transport failure');
		return Promise.resolve();
	});
	try {
		for (let attempt = 0; attempt < 40; attempt += 1) {
			const status = await fixture.read('runtime/beta/test-launch.json');
			if (status.includes('unconfirmed') && calls > 1) return;
			await Bun.sleep(250);
		}
		throw new Error('Delivery stayed failed after the transport recovered.');
	} finally {
		await stop();
		if (previousAgent === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = previousAgent;
		if (previousNonce === undefined) delete process.env.SUMMON_NONCE;
		else process.env.SUMMON_NONCE = previousNonce;
	}
}, 15000);

test('a recently crashed receiver is reclaimable without a thirty-second delay', async () => {
	const path = join(fixture.records, 'runtime/beta/receiver');
	await mkdir(path, { recursive: true });
	await writeFile(
		join(path, 'owner.json'),
		JSON.stringify({ pid: await deadPid(), nonce: randomUUID() }),
	);
	const release = await acquireReceiver('beta', 'replacement');
	try {
		expect(release).toBeDefined();
	} finally {
		await release?.();
	}
});

test('delivery recovers after five failures without a session restart', async () => {
	let now = Date.now();
	const clock = spyOn(Date, 'now').mockImplementation(() => now);
	let calls = 0;
	const stop = await startMailWatcher('beta', 'retry-launch', () => {
		calls++;
		if (calls <= 5) throw new NotificationNotSentError('temporary failure');
		return Promise.resolve();
	});
	try {
		for (let attempt = 0; attempt < 150; attempt++) {
			now += 61000;
			const status = await fixture.read('runtime/beta/retry-launch.json');
			if (calls > 5 && status.includes('unconfirmed')) break;
			await Bun.sleep(100);
		}
		expect(calls).toBe(6);
		expect(await fixture.read('runtime/beta/retry-launch.json')).toContain('unconfirmed');
	} finally {
		await stop();
		clock.mockRestore();
	}
}, 20000);

test('failed watcher initialization releases ownership for the next startup', async () => {
	const blocked = join(fixture.records, 'runtime/beta/broken.attempts');
	await mkdir(blocked, { recursive: true });
	const result: unknown = await startMailWatcher('beta', 'broken', () => Promise.resolve()).catch(
		(error: unknown) => error,
	);
	expect(result).toBeInstanceOf(Error);
	await rmdir(blocked);
	const release = await acquireReceiver('beta', 'replacement');
	try {
		expect(release).toBeDefined();
	} finally {
		await release?.();
	}
});

test('a waiting session acquires delivery after the previous receiver releases it', async () => {
	const release = await acquireReceiver('beta', 'old-session');
	let calls = 0;
	const stop = await startMailWatcher('beta', 'new-session', () => {
		calls++;
		return Promise.resolve();
	});
	try {
		expect(calls).toBe(0);
		await release?.();
		for (let attempt = 0; attempt < 30 && calls === 0; attempt++) await Bun.sleep(100);
		expect(calls).toBeGreaterThan(0);
		expect(await fixture.read('runtime/beta/new-session.json')).toContain('unconfirmed');
	} finally {
		await stop();
		await release?.();
	}
});

test('dead writer locks recover without admitting two concurrent mutations', async () => {
	const path = join(fixture.records, 'mutation.lock');
	await writeFile(path, JSON.stringify({ pid: await deadPid(), nonce: randomUUID() }));
	let active = 0;
	let completed = 0;
	const operation = async () => {
		active += 1;
		expect(active).toBe(1);
		await Bun.sleep(30);
		active -= 1;
		completed += 1;
	};
	await Promise.all([locked(path, operation), locked(path, operation)]);
	expect(completed).toBe(2);
});
