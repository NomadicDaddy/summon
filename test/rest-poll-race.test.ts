import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { locked } from '../src/mail-files.ts';
import { readRest, refreshRest, restSuppressed } from '../src/rest.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeActivity('alpha', 'test-launch');
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

test('a confirmation completed during the lock probe is read before taking the inactive shortcut', async () => {
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
	const ready = await readRest('alpha');
	expect(ready?.mode).toBe('ready');
	expect((await fixture.run(['--rest', 'cancel'], 'alpha')).code).toBe(0);
	const path = join(fixture.records, 'runtime/alpha/rest.json');
	const originalRead = fs.readFile;
	let advanced = false;
	const reads = spyOn(fs, 'readFile').mockImplementation(
		new Proxy(originalRead, {
			async apply(target, receiver: unknown, args: unknown[]) {
				try {
					const result: unknown = Reflect.apply(target, receiver, args);
					return await result;
				} finally {
					if (!advanced && String(args[0]) === `${path}.lock`) {
						advanced = true;
						await locked(`${path}.lock`, () =>
							fs.writeFile(path, JSON.stringify(ready)),
						);
					}
				}
			},
		}),
	);
	try {
		expect((await refreshRest('alpha'))?.mode).toBe('ready');
		expect(advanced).toBe(true);
		expect(await restSuppressed('alpha')).toBe(true);
	} finally {
		reads.mockRestore();
	}
});

test('transient Windows lock-read denial takes the locked path instead of failing polling', async () => {
	const path = join(fixture.records, 'runtime/alpha/rest.json.lock');
	const originalRead = fs.readFile;
	let denied = false;
	const reads = spyOn(fs, 'readFile').mockImplementation(
		new Proxy(originalRead, {
			async apply(target, receiver: unknown, args: unknown[]) {
				if (!denied && String(args[0]) === path) {
					denied = true;
					throw Object.assign(new Error('Fixture handle closing'), { code: 'EPERM' });
				}
				const result: unknown = Reflect.apply(target, receiver, args);
				return await result;
			},
		}),
	);
	const links = spyOn(fs, 'link');
	try {
		expect(await refreshRest('alpha')).toBeUndefined();
		expect(denied).toBe(true);
		expect(links).toHaveBeenCalled();
	} finally {
		reads.mockRestore();
		links.mockRestore();
	}
});

test('automatic suppression always serializes its decision even when no rest state exists', async () => {
	const links = spyOn(fs, 'link');
	try {
		expect(await restSuppressed('alpha')).toBe(false);
		expect(links).toHaveBeenCalled();
	} finally {
		links.mockRestore();
	}
});
