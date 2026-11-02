import { afterEach, beforeEach, test } from 'bun:test';
import { renameSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCRATCH_MAX_AGE_MS } from '../../src/scratch-retention.ts';

/** Removal needs the Windows handle worker; elsewhere expiry refuses. */
export const winTest = test.skipIf(process.platform !== 'win32');
/** Each run starts pwsh and compiles the worker. */
export const SLOW = 60_000;

// Whole seconds, so file times set from it compare exactly.
export const startedAt = Date.parse('2026-10-23T17:00:00Z');
export const cutoff = startedAt - SCRATCH_MAX_AGE_MS;
export const old = new Date(cutoff - 86_400_000);
export const fresh = new Date(startedAt - 86_400_000);

/** A disposable store with scratch/shared, plus an outside folder, fresh for every test. */
export function scratchStore() {
	const at = { base: '', store: '', outside: '' };
	beforeEach(async () => {
		at.base = await mkdtemp(join(tmpdir(), 'summon-scratch-expiry-'));
		at.store = join(at.base, 'store');
		at.outside = join(at.base, 'outside');
		await mkdir(join(at.store, 'scratch', 'shared'), { recursive: true });
		await mkdir(at.outside, { recursive: true });
	});
	afterEach(async () => {
		await rm(at.base, { recursive: true, force: true });
	});
	return Object.assign(at, {
		scratch: (...parts: string[]) => join(at.store, 'scratch', ...parts),
	});
}

export async function file(path: string, when: Date, text = 'x'): Promise<void> {
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, text);
	await utimes(path, when, when);
}

export async function folder(path: string, when: Date): Promise<void> {
	await mkdir(path, { recursive: true });
	await utimes(path, when, when);
}

/** The error code of a rename attempted while the worker holds its handles, or 'renamed'. */
export function tryRename(from: string, to: string): string {
	try {
		renameSync(from, to);
		return 'renamed';
	} catch (error: unknown) {
		return (error as { code?: string }).code ?? 'unknown';
	}
}
