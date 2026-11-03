import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { link, readFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import { expireScratch, expiryLine, operatorScratchExpiry } from '../src/scratch-retention.ts';
import {
	cutoff,
	file,
	folder,
	fresh,
	old,
	scratchStore,
	SLOW,
	startedAt,
	winTest,
} from './fixtures/scratch-store.ts';

// Safety controls: scratch-expiry-safety.test.ts. CLI routing: scratch-expiry-routing.test.ts.
const at = scratchStore();
const { scratch } = at;

winTest(
	'strictly older files go; the exact cutoff and newer files stay',
	async () => {
		await file(scratch('ada', 'old.txt'), old);
		await file(scratch('ada', 'fresh.txt'), fresh);
		await file(scratch('ada', 'boundary.txt'), new Date(cutoff));
		await file(scratch('shared', 'old-note.md'), old);
		await folder(scratch('ada'), old);
		const report = await expireScratch(at.store, startedAt);
		expect(report.removedFiles).toBe(2);
		expect(existsSync(scratch('ada', 'old.txt'))).toBe(false);
		expect(existsSync(scratch('shared', 'old-note.md'))).toBe(false);
		expect(existsSync(scratch('ada', 'fresh.txt'))).toBe(true);
		expect(existsSync(scratch('ada', 'boundary.txt'))).toBe(true);
		expect(report.cutoff).toBe(new Date(cutoff).toISOString());
		expect(report.refused).toBeUndefined();
		expect(report.incomplete).toBeUndefined();
	},
	SLOW,
);

winTest(
	'an old parent keeps a fresh child; only empty folders that were already old are removed',
	async () => {
		await file(scratch('ada', 'keep', 'fresh.txt'), fresh);
		await file(scratch('ada', 'keep', 'old.txt'), old);
		await folder(scratch('ada', 'keep'), old);
		await file(scratch('ada', 'gone', 'deep', 'old.txt'), old);
		await folder(scratch('ada', 'gone', 'deep'), old);
		await folder(scratch('ada', 'gone'), old);
		await folder(scratch('ada', 'empty-old'), old);
		await folder(scratch('ada', 'empty-fresh'), fresh);
		const report = await expireScratch(at.store, startedAt);
		expect(existsSync(scratch('ada', 'keep', 'fresh.txt'))).toBe(true);
		expect(existsSync(scratch('ada', 'keep', 'old.txt'))).toBe(false);
		expect(existsSync(scratch('ada', 'gone'))).toBe(false);
		expect(existsSync(scratch('ada', 'empty-old'))).toBe(false);
		expect(existsSync(scratch('ada', 'empty-fresh'))).toBe(true);
		expect(report.removedDirectories).toBe(3);
	},
	SLOW,
);

winTest(
	'non-ASCII store, folder and file names survive the console code page both ways',
	async () => {
		const wide = join(at.base, 'störe-名');
		await file(join(wide, 'scratch', 'zoë', 'old-名.txt'), old);
		await file(join(wide, 'scratch', 'zoë', 'linked-é.txt'), old);
		await link(join(wide, 'scratch', 'zoë', 'linked-é.txt'), join(at.outside, 'other.txt'));
		const report = await expireScratch(wide, startedAt);
		expect(report.refused).toBeUndefined();
		expect(report.removedFiles).toBe(1);
		expect(existsSync(join(wide, 'scratch', 'zoë', 'old-名.txt'))).toBe(false);
		expect(report.skippedSample.map((item) => item.path)).toEqual([
			join('zoë', 'linked-é.txt'),
		]);
	},
	SLOW,
);

winTest(
	'the scratch root, member homes and shared stay even when empty and old',
	async () => {
		await folder(scratch('ghost'), old);
		await folder(scratch('shared'), old);
		await utimes(scratch(), old, old);
		await expireScratch(at.store, startedAt);
		expect(existsSync(scratch('ghost'))).toBe(true);
		expect(existsSync(scratch('shared'))).toBe(true);
		expect(existsSync(scratch())).toBe(true);
	},
	SLOW,
);

winTest(
	'a helper that cannot start refuses the run and removes nothing',
	async () => {
		await file(scratch('ada', 'old.txt'), old);
		const report = await expireScratch(at.store, startedAt, {
			helper: join(at.base, 'missing-helper.ps1'),
		});
		expect(report.refused).toStartWith('the scratch expiry helper could not start');
		expect(existsSync(scratch('ada', 'old.txt'))).toBe(true);
		expect(expiryLine(report)).toContain('Nothing was removed');
	},
	SLOW,
);

winTest(
	'the report line is concise, and a missing scratch folder is a no-op',
	async () => {
		await rm(scratch(), { recursive: true });
		const empty = await expireScratch(at.store, startedAt);
		expect(empty).toMatchObject({ removedFiles: 0, skipped: 0 });
		expect(empty.refused).toBeUndefined();
		const line = expiryLine({
			...empty,
			skipped: 25,
			skipReasons: { 'has other hard links, not removed': 25 },
			detailsPath: join(at.store, 'logs', 'scratch-expiry-details.json'),
			skippedSample: Array.from({ length: 20 }, (_, index) => ({
				path: `a"b\n${index}`,
				reason: 'has other hard links, not removed',
			})),
		});
		expect(line).toContain('kept 25 old hard-linked files for safety');
		expect(line).toContain('full details:');
		expect(line).not.toContain('a"b');
		expect(line).not.toContain('\n');
	},
	SLOW,
);

winTest(
	'full hard-link diagnostics are saved while startup reports one concise line',
	async () => {
		for (let index = 0; index < 25; index++) {
			const name = `linked-${index}.txt`;
			await file(scratch('ada', name), old);
			await link(scratch('ada', name), join(at.outside, name));
		}
		const report = await expireScratch(at.store, startedAt);
		const line = expiryLine(report);
		expect(report.skipped).toBe(25);
		expect(report.skippedSample).toHaveLength(20);
		expect(line).toContain('kept 25 old hard-linked files for safety');
		expect(line).not.toContain('linked-0.txt');
		const detailsPath = report.detailsPath;
		expect(detailsPath).toBe(join(at.store, 'logs', 'scratch-expiry-details.json'));
		if (!detailsPath) throw new Error('The complete skip report was not saved.');
		const details = JSON.parse(await readFile(detailsPath, 'utf8')) as {
			skipped: number;
			skips: { path: string; reason: string }[];
		};
		expect(details.skipped).toBe(25);
		expect(details.skips).toHaveLength(25);
		expect(details.skips.map(({ path }) => path)).toContain(join('ada', 'linked-24.txt'));
		expect(existsSync(scratch('ada', 'linked-24.txt'))).toBe(true);
	},
	SLOW,
);

test("a teammate's CLI never runs the purge", async () => {
	await file(scratch('ada', 'old.txt'), old);
	const previousAgent = process.env.SUMMON_AGENT;
	const previousHome = process.env.SUMMON_HOME;
	process.env.SUMMON_AGENT = 'ada';
	process.env.SUMMON_HOME = at.store;
	try {
		await operatorScratchExpiry(startedAt);
	} finally {
		if (previousAgent === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = previousAgent;
		if (previousHome === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previousHome;
	}
	expect(existsSync(scratch('ada', 'old.txt'))).toBe(true);
});

test.skipIf(process.platform === 'win32')(
	'macOS and Linux refuse expiry and remove nothing',
	async () => {
		await file(scratch('ada', 'old.txt'), old);
		const report = await expireScratch(at.store, startedAt);
		expect(report.refused).toBe("scratch expiry isn't supported on this platform");
		expect(existsSync(scratch('ada', 'old.txt'))).toBe(true);
	},
);
