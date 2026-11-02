import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Morgan's review repro (cf516b5): the real atomic record write lands, releasing the record's
 * write lock then fails with EACCES, and any later read of the record fails with EIO. The write's
 * own report decides the outcome, so this is applied, never "not changed".
 */
const realReadFile = fs.readFile;
const realUnlink = fs.unlink;
let active = false;
let releaseFailed = false;
let target = '';
await mock.module('node:fs/promises', () => ({
	...fs,
	readFile: (...args: Parameters<typeof fs.readFile>) => {
		if (active && releaseFailed && args[0] === target)
			return Promise.reject(
				Object.assign(new Error('simulated recovery read EIO'), { code: 'EIO' }),
			);
		return realReadFile(...args);
	},
	unlink: (path: Parameters<typeof fs.unlink>[0]) => {
		if (active && String(path) === `${target}.write-lock`) {
			releaseFailed = true;
			return Promise.reject(
				Object.assign(new Error('simulated record lock release EACCES'), {
					code: 'EACCES',
				}),
			);
		}
		return realUnlink(path);
	},
}));
const { mailHarness } = await import('./fixtures/mail-harness.ts');
const { registrationCommand } = await import('../src/registration-text.ts');
const { loadAgent, recordPath } = await import('../src/store.ts');
const { profileTextRevision } = await import('../src/profile-text.ts');
const { readRegistrationAudit, reconcileRegistrationAudit } =
	await import('../src/registration-audit.ts');

const fixture = await mailHarness();
const previous = process.env.SUMMON_HOME;
afterAll(async () => {
	active = false;
	process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

test('a landed write is applied even when lock release and the reread both fail', async () => {
	process.env.SUMMON_HOME = fixture.records;
	delete process.env.SUMMON_AGENT;
	delete process.env.SUMMON_NONCE;
	target = recordPath('beta');
	const before = await loadAgent('beta');
	if (!before) throw new Error('fixture missing beta');
	const input = join(fixture.root, 'domain.txt');
	await fs.writeFile(input, 'The write really landed');
	const log = spyOn(console, 'log').mockImplementation(() => undefined);
	active = true;
	let error = '';
	try {
		await registrationCommand([
			'edit',
			'beta',
			'--revision',
			profileTextRevision(before),
			'--domain-file',
			input,
		]);
	} catch (failure: unknown) {
		error = String(failure);
	} finally {
		active = false;
		log.mockRestore();
	}
	const stored = JSON.parse(await realReadFile(target, 'utf8')) as {
		expertise: string;
		domain: string;
	};
	const audit = await readRegistrationAudit();
	expect(stored.domain).toBe('The write really landed');
	expect(releaseFailed).toBe(true);
	expect(audit.entries.map((entry) => entry.kind)).toEqual(['intent', 'applied']);
	expect(
		reconcileRegistrationAudit(audit.entries, () => stored).map((row) => row.status),
	).toEqual(['applied']);
	expect(error).toContain("beta's record changed and audit");
	expect(error).toContain('simulated record lock release EACCES');
	expect(error).not.toContain('NOT changed');
});
