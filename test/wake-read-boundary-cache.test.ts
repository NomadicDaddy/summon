import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { stat, unlink, utimes, writeFile } from 'node:fs/promises';

import type { CheckpointPackage, CheckpointState } from '../src/checkpoint-package-model.ts';

import * as checkpointModel from '../src/checkpoint-package-model.ts';
import { checkpointHash } from '../src/checkpoint-package-model.ts';
import { checkpointPackagePath, checkpointStatePath } from '../src/checkpoint-package-store.ts';
import { atomicWrite } from '../src/mail-files.ts';
import { activeWakeReadBoundary, wakePartCovered } from '../src/wake-read-boundary.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
};

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'cache-fixture';
});

afterEach(async () => {
	if (previous.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous.home;
	if (previous.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previous.agent;
	if (previous.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previous.nonce;
	await fixture.dispose();
});

function packageFixture(body = 'x'.repeat(20_000)): CheckpointPackage {
	return {
		version: 1,
		owner: 'alpha',
		id: randomUUID(),
		createdAt: new Date().toISOString(),
		items: [],
		pages: [{ receipt: randomUUID(), payload: { body }, completeMail: [] }],
		finalReceipt: randomUUID(),
		sources: { room: { from: 0, through: 1 }, holds: {} },
	};
}

async function publish(packet: CheckpointPackage, raw = JSON.stringify(packet)): Promise<void> {
	const state: CheckpointState = {
		version: 2,
		current: { id: packet.id, sha256: checkpointHash(packet), page: 0 },
		seenHolds: {},
	};
	await atomicWrite(checkpointPackagePath('alpha'), raw);
	await atomicWrite(checkpointStatePath('alpha'), JSON.stringify(state));
}

async function rejectsWith(operation: Promise<unknown>, message: string): Promise<void> {
	let thrown: unknown;
	try {
		await operation;
	} catch (error: unknown) {
		thrown = error;
	}
	if (!(thrown instanceof Error)) throw new Error(`Expected rejection containing ${message}.`);
	expect(thrown.message).toContain(message);
}

test('unchanged large package parses once, but same-size same-mtime new bytes parse again', async () => {
	const packet = packageFixture();
	const compact = JSON.stringify(packet);
	await publish(packet, `${compact} `);
	const path = checkpointPackagePath('alpha');
	const fixed = new Date('2020-01-01T00:00:00.000Z');
	await utimes(path, fixed, fixed);
	const before = await stat(path);
	const startedAt = Date.parse(packet.createdAt) - 1000;
	const parse = spyOn(checkpointModel, 'parseCheckpointPackage');
	try {
		const first = await activeWakeReadBoundary('alpha', startedAt);
		expect(first).toBeDefined();
		expect(await activeWakeReadBoundary('alpha', startedAt)).toBe(first);
		expect(parse).toHaveBeenCalledTimes(1);

		await writeFile(path, ` ${compact}`);
		await utimes(path, fixed, fixed);
		const after = await stat(path);
		expect(after.size).toBe(before.size);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		const replacement = await activeWakeReadBoundary('alpha', startedAt);
		if (!replacement) throw new Error('Replacement package was not active.');
		expect(replacement).not.toBe(first);
		expect(parse).toHaveBeenCalledTimes(2);
		expect(
			wakePartCovered(
				{
					target: { source: 'room', key: '', through: 2, ids: [] },
					text: '',
					needed: () => Promise.resolve(true),
					acknowledged: () => Promise.resolve(false),
					mark: () => Promise.resolve(),
				},
				replacement,
			),
		).toBe(false);
	} finally {
		parse.mockRestore();
	}
});

test('invalid UTF-8 bytes fail visibly and evict a previously validated package', async () => {
	const packet = packageFixture('\uFFFD');
	await publish(packet);
	const path = checkpointPackagePath('alpha');
	const serialized = Buffer.from(JSON.stringify(packet));
	const marker = serialized.indexOf(Buffer.from('\uFFFD'));
	if (marker < 0) throw new Error('Fixture replacement character was not serialized.');
	const variant = (byte: number): Buffer =>
		Buffer.concat([
			serialized.subarray(0, marker),
			Buffer.from([byte]),
			serialized.subarray(marker + 3),
		]);
	const fixed = new Date('2020-01-01T00:00:00.000Z');
	const startedAt = Date.parse(packet.createdAt) - 1000;
	const parse = spyOn(checkpointModel, 'parseCheckpointPackage');
	try {
		const first = await activeWakeReadBoundary('alpha', startedAt);
		await writeFile(path, variant(0x80));
		await utimes(path, fixed, fixed);
		const before = await stat(path);
		await rejectsWith(
			activeWakeReadBoundary('alpha', startedAt),
			'Active checkpoint package contains invalid UTF-8',
		);
		await writeFile(path, variant(0x81));
		await utimes(path, fixed, fixed);
		const after = await stat(path);
		expect(after.size).toBe(before.size);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		await rejectsWith(
			activeWakeReadBoundary('alpha', startedAt),
			'Active checkpoint package contains invalid UTF-8',
		);
		await writeFile(path, serialized);
		const second = await activeWakeReadBoundary('alpha', startedAt);
		expect(second).not.toBe(first);
		expect(parse).toHaveBeenCalledTimes(2);
	} finally {
		parse.mockRestore();
	}
});

test('page, restart, corrupt bytes and missing package never inherit a stale validation', async () => {
	const packet = packageFixture();
	const raw = JSON.stringify(packet);
	await publish(packet, raw);
	const startedAt = Date.parse(packet.createdAt) - 1000;
	const parse = spyOn(checkpointModel, 'parseCheckpointPackage');
	try {
		const first = await activeWakeReadBoundary('alpha', startedAt);
		expect(parse).toHaveBeenCalledTimes(1);
		const state: CheckpointState = {
			version: 2,
			current: { id: packet.id, sha256: checkpointHash(packet), page: 1 },
			seenHolds: {},
		};
		await atomicWrite(checkpointStatePath('alpha'), JSON.stringify(state));
		expect(await activeWakeReadBoundary('alpha', startedAt)).not.toBe(first);
		expect(parse).toHaveBeenCalledTimes(2);
		expect(
			await activeWakeReadBoundary('alpha', Date.parse(packet.createdAt) + 1),
		).toBeUndefined();
		expect(parse).toHaveBeenCalledTimes(3);

		await writeFile(
			checkpointPackagePath('alpha'),
			raw.replace('"owner":"alpha"', '"owner":"bravo"'),
		);
		await rejectsWith(
			activeWakeReadBoundary('alpha', startedAt),
			'Invalid frozen checkpoint package',
		);
		await writeFile(checkpointPackagePath('alpha'), raw);
		expect(await activeWakeReadBoundary('alpha', startedAt)).toBeDefined();
		expect(parse).toHaveBeenCalledTimes(5);

		await unlink(checkpointPackagePath('alpha'));
		await rejectsWith(
			activeWakeReadBoundary('alpha', startedAt),
			'Active checkpoint package is missing',
		);
		await writeFile(checkpointPackagePath('alpha'), raw);
		expect(await activeWakeReadBoundary('alpha', startedAt)).toBeDefined();
		expect(parse).toHaveBeenCalledTimes(6);
	} finally {
		parse.mockRestore();
	}
});

test('changed state identity, corrupt state and completion invalidate prior cache entries', async () => {
	const packet = packageFixture();
	await publish(packet);
	const startedAt = Date.parse(packet.createdAt) - 1000;
	const statePath = checkpointStatePath('alpha');
	const valid: CheckpointState = {
		version: 2,
		current: { id: packet.id, sha256: checkpointHash(packet), page: 0 },
		seenHolds: {},
	};
	const parse = spyOn(checkpointModel, 'parseCheckpointPackage');
	try {
		await activeWakeReadBoundary('alpha', startedAt);
		expect(parse).toHaveBeenCalledTimes(1);
		await atomicWrite(
			statePath,
			JSON.stringify({ ...valid, current: { ...valid.current, id: randomUUID() } }),
		);
		await rejectsWith(
			activeWakeReadBoundary('alpha', startedAt),
			'Active checkpoint package is invalid',
		);
		await atomicWrite(statePath, JSON.stringify(valid));
		await activeWakeReadBoundary('alpha', startedAt);
		expect(parse).toHaveBeenCalledTimes(3);

		await atomicWrite(
			statePath,
			JSON.stringify({ ...valid, current: { ...valid.current, sha256: '0'.repeat(64) } }),
		);
		await rejectsWith(
			activeWakeReadBoundary('alpha', startedAt),
			'Active checkpoint package is invalid',
		);
		await atomicWrite(statePath, JSON.stringify(valid));
		await activeWakeReadBoundary('alpha', startedAt);
		expect(parse).toHaveBeenCalledTimes(5);

		await atomicWrite(statePath, '{');
		await rejectsWith(
			activeWakeReadBoundary('alpha', startedAt),
			'Checkpoint state needs the reviewed offline migration',
		);
		await atomicWrite(statePath, JSON.stringify(valid));
		await activeWakeReadBoundary('alpha', startedAt);
		expect(parse).toHaveBeenCalledTimes(6);

		await atomicWrite(statePath, JSON.stringify({ version: 2, seenHolds: {} }));
		expect(await activeWakeReadBoundary('alpha', startedAt)).toBeUndefined();
		await atomicWrite(statePath, JSON.stringify(valid));
		await activeWakeReadBoundary('alpha', startedAt);
		expect(parse).toHaveBeenCalledTimes(7);
	} finally {
		parse.mockRestore();
	}
});
