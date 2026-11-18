import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { State } from '../src/schedule-store.ts';

import { SCHEDULE_WARNING_BYTES, warnScheduleSize } from '../src/schedule-size-warning.ts';

let dir = '';
let path = '';
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'summon-schedule-size-'));
	path = join(dir, 'state.json');
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function sized(bytes: number): Promise<void> {
	const file = await open(path, 'w');
	await file.truncate(bytes);
	await file.close();
}
const state = (warnedStep?: number): State => ({
	version: 2,
	schedules: [],
	runs: [],
	...(warnedStep === undefined ? {} : { warnedStep }),
});
/** A fault writer that records each warning. */
const into = (warned: string[]) => (text: string) => {
	warned.push(text);
	return Promise.resolve();
};
/** A state saver that records the step it was asked to persist. */
const saving = (saved: (number | undefined)[]) => (value: State) => {
	saved.push(value.warnedStep);
	return Promise.resolve(0);
};
const failing = (message: string) => () => Promise.reject(new Error(message));

test('below the first step nothing is warned or saved', async () => {
	await sized(SCHEDULE_WARNING_BYTES - 1);
	const warned: string[] = [];
	const saved: (number | undefined)[] = [];
	await warnScheduleSize(state(), path, into(warned), saving(saved));
	expect(warned).toHaveLength(0);
	expect(saved).toHaveLength(0);
});

test('each step warns once, and the step is saved only after the warning succeeds', async () => {
	await sized(SCHEDULE_WARNING_BYTES);
	const warned: string[] = [];
	const saved: (number | undefined)[] = [];
	await warnScheduleSize(state(), path, into(warned), saving(saved));
	expect(warned).toHaveLength(1);
	expect(warned[0]).toContain('past 32 MiB');
	expect(saved).toEqual([1]);
	await warnScheduleSize(state(1), path, into(warned), saving(saved));
	expect(warned).toHaveLength(1);
	await sized(SCHEDULE_WARNING_BYTES * 2);
	await warnScheduleSize(state(1), path, into(warned), saving(saved));
	expect(warned).toHaveLength(2);
	expect(saved).toEqual([1, 2]);
});

test('a failing fault journal or state save never throws, and the warning is retried later', async () => {
	await sized(SCHEDULE_WARNING_BYTES);
	const saved: (number | undefined)[] = [];
	const unwarned = state();
	await warnScheduleSize(unwarned, path, failing('journal locked'), saving(saved));
	expect(saved).toHaveLength(0);
	expect(unwarned.warnedStep).toBeUndefined();
	// The fault was written but the state save failed: a later dispatch warns again.
	const warned: string[] = [];
	await warnScheduleSize(state(), path, into(warned), failing('disk full'));
	await warnScheduleSize(state(), path, into(warned), failing('disk full'));
	expect(warned).toHaveLength(2);
});

test('a missing state file is ignored', async () => {
	const saved: (number | undefined)[] = [];
	await warnScheduleSize(state(), path, failing('unreached'), saving(saved));
	expect(saved).toHaveLength(0);
});
