import { afterAll, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as files from '../src/mail-files.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

/**
 * Faults injected at the three audit steps; everything else is real.
 * - `write`: the record write fails before its rename, and says so as atomicWrite does.
 * - `unknown`: the record write rejects without reporting how far it got.
 * - `release`: the audit lock's release fails after the intent line landed.
 * - `marker`: the applied marker's append fails before it writes anything.
 */
let fault: 'write' | 'unknown' | 'release' | 'marker' | undefined;
let auditCalls = 0;
const realAtomicWrite = files.atomicWrite;
const realLocked = files.locked;
await mock.module('../src/mail-files.ts', () => ({
	...files,
	atomicWrite: (path: string, text: string, progress?: files.WriteProgress) => {
		if (!path.endsWith('beta.json') || (fault !== 'write' && fault !== 'unknown'))
			return realAtomicWrite(path, text, progress);
		if (fault === 'write' && progress) progress.failed = true;
		return Promise.reject(new Error('simulated disk full'));
	},
	locked: async <T>(path: string, operation: () => Promise<T>, attempts?: number) => {
		if (!path.endsWith('registration-text.jsonl.lock'))
			return realLocked(path, operation, attempts);
		auditCalls++;
		if (fault === 'marker' && auditCalls === 2) throw new Error('simulated marker failure');
		const result = await realLocked(path, operation, attempts);
		if (fault === 'release' && auditCalls === 1) throw new Error('simulated release failure');
		return result;
	},
}));
const { registrationCommand } = await import('../src/registration-text.ts');
const { readRegistrationAudit, reconcileRegistrationAudit, registrationAuditPath } =
	await import('../src/registration-audit.ts');
const { loadAgent, recordPath } = await import('../src/store.ts');
const { profileTextRevision } = await import('../src/profile-text.ts');

const fixture = await mailHarness();
const previous = process.env.SUMMON_HOME;
afterAll(async () => {
	process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});
beforeEach(async () => {
	process.env.SUMMON_HOME = fixture.records;
	delete process.env.SUMMON_AGENT;
	auditCalls = 0;
	await writeFile(registrationAuditPath(), '').catch(() => undefined);
});

async function attempt(kind: typeof fault, text: string): Promise<string> {
	const beta = await loadAgent('beta');
	if (!beta) throw new Error('fixture missing beta');
	const path = join(fixture.root, 'domain.txt');
	await writeFile(path, text);
	const log = spyOn(console, 'log').mockImplementation(() => undefined);
	fault = kind;
	try {
		await registrationCommand([
			'edit',
			'beta',
			'--revision',
			profileTextRevision(beta),
			'--domain-file',
			path,
		]);
		return 'resolved';
	} catch (error: unknown) {
		return String(error);
	} finally {
		fault = undefined;
		log.mockRestore();
	}
}
async function statuses(): Promise<string[]> {
	const { entries } = await readRegistrationAudit();
	const beta = await loadAgent('beta');
	return reconcileRegistrationAudit(entries, () => beta).map(({ status }) => status);
}

test('a record write failing after the intent is marked not-applied and fails', async () => {
	const before = await readFile(recordPath('beta'), 'utf8');
	const failure = await attempt('write', 'Never stored');
	expect(failure).toContain('The record was NOT changed (simulated disk full)');
	expect(failure).toContain('is marked not-applied');
	expect(await readFile(recordPath('beta'), 'utf8')).toBe(before);
	const { entries } = await readRegistrationAudit();
	expect(entries.map((entry) => entry.kind)).toEqual(['intent', 'not-applied']);
	expect(entries[1]?.id).toBe(entries[0]?.id);
	expect(await statuses()).toEqual(['not-applied']);
});

test('a record write whose outcome is unknowable gets no marker and stays unresolved', async () => {
	const failure = await attempt('unknown', 'Maybe stored');
	expect(failure).toContain('is unknown (simulated disk full). No outcome marker was written');
	const { entries } = await readRegistrationAudit();
	expect(entries.map((entry) => entry.kind)).toEqual(['intent']);
	expect(await statuses()).toEqual(['unresolved']);
});

test('a lock release failing after the intent landed leaves the record unchanged and unresolved', async () => {
	const before = await readFile(recordPath('beta'), 'utf8');
	const failure = await attempt('release', 'Not after a doubtful intent');
	expect(failure).toContain(
		'The audit intent could not be confirmed, so the record was not changed',
	);
	expect(await readFile(recordPath('beta'), 'utf8')).toBe(before);
	const { entries } = await readRegistrationAudit();
	expect(entries.map((entry) => entry.kind)).toEqual(['intent']);
	expect(await statuses()).toEqual(['unresolved']);
});

test('a missing applied marker fails loudly and reconciles by hash as applied-unmarked', async () => {
	const failure = await attempt('marker', 'Stored without a marker');
	expect(failure).toContain('record changed, but the audit commit marker');
	expect((await loadAgent('beta'))?.domain).toBe('Stored without a marker');
	const { entries } = await readRegistrationAudit();
	expect(entries.map((entry) => entry.kind)).toEqual(['intent']);
	expect(await statuses()).toEqual(['applied-unmarked']);
});

test('an intent with no outcome after a crash never reads as applied', () => {
	const intent = {
		kind: 'intent' as const,
		id: 'crashed',
		at: '2026-10-15T00:00:00.000Z',
		actor: 'operator',
		target: 'beta',
		decision: null,
		changes: { domain: { old: 'a'.repeat(64), new: 'b'.repeat(64) } },
	};
	expect(
		reconcileRegistrationAudit([intent], () => ({ expertise: '', domain: 'unchanged' })),
	).toEqual([{ intent, status: 'unresolved' }]);
	expect(reconcileRegistrationAudit([intent], () => undefined)[0]?.status).toBe('unresolved');
	expect(
		reconcileRegistrationAudit(
			[intent, { kind: 'applied', id: 'crashed', at: intent.at }],
			() => undefined,
		)[0]?.status,
	).toBe('applied');
});
