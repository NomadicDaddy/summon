import { afterEach, beforeEach, expect, test } from 'bun:test';
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { verifyClaims } from '../src/claims.ts';
import { locked } from '../src/mail-files.ts';
import { removeAgent } from '../src/remove.ts';
import {
	createSchedule,
	dispatchSchedules,
	enableSchedule,
	listSchedules,
	removeScheduleOwner,
} from '../src/schedules.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

async function pendingWriters(folder: string, count: number): Promise<boolean> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (
			(await readdir(join(fixture.records, folder))).filter((name) =>
				name.endsWith('.pending'),
			).length >= count
		)
			return true;
		await Bun.sleep(10);
	}
	return false;
}

test('archive removes owned claims and pauses schedules without transferring work to a reused name', async () => {
	await createSchedule({
		owner: 'alpha',
		title: 'Old owner',
		prompt: 'Old work',
		everyMinutes: 1,
	});
	await createSchedule({
		owner: 'beta',
		title: 'Other owner',
		prompt: 'Other work',
		everyMinutes: 1,
	});
	await mkdir(join(fixture.records, 'claims'));
	await writeFile(join(fixture.records, 'claims/alpha.md'), 'Original claims');
	await writeFile(join(fixture.records, 'claims/alpha.report.json'), 'Original report');
	await writeFile(join(fixture.records, 'claims/beta.md'), 'Keep other claims');
	await removeAgent('alpha', true);
	const schedules = await listSchedules();
	expect(schedules.schedules.find((item) => item.owner === 'alpha')?.enabled).toBe(false);
	expect(schedules.schedules.find((item) => item.owner === 'beta')?.enabled).toBe(true);
	expect(await Bun.file(join(fixture.records, 'claims/alpha.md')).exists()).toBe(false);
	expect(await Bun.file(join(fixture.records, 'claims/alpha.report.json')).exists()).toBe(false);
	expect(await readFile(join(fixture.records, 'claims/beta.md'), 'utf8')).toBe(
		'Keep other claims',
	);
	const archive = (await readdir(join(fixture.records, 'archives')))[0];
	if (!archive) throw new Error('Missing archive');
	expect(await readFile(join(fixture.records, 'archives', archive, 'claims.md'), 'utf8')).toBe(
		'Original claims',
	);
	expect(
		await readFile(join(fixture.records, 'archives', archive, 'claims.report.json'), 'utf8'),
	).toBe('Original report');
	await writeFile(
		join(fixture.records, 'alpha.json'),
		JSON.stringify(newRecord('alpha', fixture.root, 'kilo')),
	);
	await dispatchSchedules(
		(owner) => Promise.resolve(owner === 'alpha'),
		() => Promise.resolve(),
		Date.now() + 60001,
	);
	expect((await listSchedules()).runs).toEqual([]);
	expect(await verifyClaims('alpha')).toBeUndefined();
});

test('creation and enabling wait for owner removal and reject the removed owner', async () => {
	const schedule = await createSchedule({
		owner: 'alpha',
		title: 'Old',
		prompt: 'Work',
		everyMinutes: 1,
	});
	let enter: () => void = () => {};
	let release: () => void = () => {};
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const removal = removeScheduleOwner('alpha', async () => {
		enter();
		await barrier;
		await rm(join(fixture.records, 'alpha.json'));
	});
	await entered;
	const creating = createSchedule({
		owner: 'alpha',
		title: 'Race',
		prompt: 'Work',
		everyMinutes: 1,
	}).catch(String);
	const enabling = enableSchedule(schedule.id, true).catch(String);
	const waiting = await pendingWriters('schedules', 3);
	release();
	expect(await removal).toBe(1);
	expect(waiting).toBe(true);
	expect(await creating).toContain('Unknown schedule owner');
	expect(await enabling).toContain('Unknown schedule owner');
	expect((await listSchedules()).schedules).toHaveLength(1);
});

test('claims verification rechecks registration after acquiring the removal lock', async () => {
	await mkdir(join(fixture.records, 'claims'));
	await writeFile(join(fixture.records, 'claims/alpha.md'), '# No published claims');
	let enter: () => void = () => {};
	let release: () => void = () => {};
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const removal = locked(join(fixture.records, 'claims/alpha.report.json.lock'), async () => {
		enter();
		await barrier;
		await rm(join(fixture.records, 'alpha.json'));
	});
	await entered;
	const verification = verifyClaims('alpha').catch(String);
	const waiting = await pendingWriters('claims', 2);
	release();
	await removal;
	expect(waiting).toBe(true);
	expect(await verification).toContain('registered owner');
	expect(await Bun.file(join(fixture.records, 'claims/alpha.report.json')).exists()).toBe(false);
});

test('redirected claims storage refuses removal before deleting the owner', async () => {
	const outside = join(fixture.root, 'outside-claims');
	await mkdir(outside);
	await symlink(outside, join(fixture.records, 'claims'), 'junction');
	expect(await removeAgent('alpha').catch(String)).toContain('redirected');
	expect(await Bun.file(join(fixture.records, 'alpha.json')).exists()).toBe(true);
});

test('Archive keeps the member scratch folders, as it always has (Phillip #17710 covers Delete)', async () => {
	for (const path of [
		['scratch', 'alpha'],
		['scratch', 'shared', 'alpha'],
	]) {
		await mkdir(join(fixture.records, ...path), { recursive: true });
		await writeFile(join(fixture.records, ...path, 'note.md'), path.join('/'));
	}
	await removeAgent('alpha', true);
	expect(await readFile(join(fixture.records, 'scratch', 'alpha', 'note.md'), 'utf8')).toBe(
		'scratch/alpha',
	);
	expect(
		await readFile(join(fixture.records, 'scratch', 'shared', 'alpha', 'note.md'), 'utf8'),
	).toBe('scratch/shared/alpha');
	// The control: Delete on the same layout removes both.
	await writeFile(
		join(fixture.records, 'alpha.json'),
		JSON.stringify(newRecord('alpha', fixture.root, 'claude')),
	);
	await removeAgent('alpha');
	expect(await Bun.file(join(fixture.records, 'scratch', 'alpha', 'note.md')).exists()).toBe(
		false,
	);
	expect(
		await Bun.file(join(fixture.records, 'scratch', 'shared', 'alpha', 'note.md')).exists(),
	).toBe(false);
});
// Roger 817705b0: Archive never reads scratch, so a redirected scratch folder cannot block it.
test('Archive ignores a redirected scratch folder and leaves the link and its target alone', async () => {
	const outside = join(fixture.records, 'outside');
	const link = join(fixture.records, 'scratch', 'shared', 'alpha');
	await mkdir(outside);
	await writeFile(join(outside, 'keep.txt'), 'outside');
	await mkdir(dirname(link), { recursive: true });
	await symlink(outside, link, 'junction');
	// The control: Delete on the same layout refuses before removing anything.
	expect(await removeAgent('alpha').catch(String)).toContain('redirected');
	expect(await Bun.file(join(fixture.records, 'alpha.json')).exists()).toBe(true);
	await removeAgent('alpha', true);
	expect(await Bun.file(join(fixture.records, 'alpha.json')).exists()).toBe(false);
	expect((await readdir(join(fixture.records, 'archives'))).length).toBe(1);
	expect((await lstat(link)).isSymbolicLink()).toBe(true);
	expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('outside');
});
// Morticia 28d3865c: a failed scratch removal must not leave the member's schedules paused.
test.skipIf(process.platform !== 'win32')(
	'a held scratch folder fails Delete before any schedule is paused, and the retry pauses them',
	async () => {
		await createSchedule({ owner: 'alpha', title: 'Own', prompt: 'Own work', everyMinutes: 1 });
		const held = join(fixture.records, 'scratch', 'shared', 'alpha', 'deep');
		await mkdir(held, { recursive: true });
		const holder = Bun.spawn({
			cmd: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
			cwd: held,
			stdout: 'ignore',
			stderr: 'ignore',
		});
		const enabled = async () =>
			(await listSchedules()).schedules.find((item) => item.owner === 'alpha')?.enabled;
		try {
			expect(await removeAgent('alpha').catch(String)).toContain('still registered');
			expect(await enabled()).toBe(true);
			expect(await Bun.file(join(fixture.records, 'alpha.json')).exists()).toBe(true);
		} finally {
			holder.kill();
			await holder.exited;
		}
		await removeAgent('alpha');
		expect(await enabled()).toBe(false);
		expect(await Bun.file(join(fixture.records, 'alpha.json')).exists()).toBe(false);
	},
);
