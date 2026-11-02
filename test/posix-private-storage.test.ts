import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	rmdir,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { roomImagePath, saveRoomImage } from '../src/room-image.ts';
import { selectTeamStorage } from '../src/team-storage.ts';
import { telegramConfig } from '../src/telegram-api.ts';

const posix = test.skipIf(process.platform === 'win32');
const previousRoot = process.env.SUMMON_HOME;
const previousTeams = process.env.SUMMON_TEAMS_HOME;
let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-posix-'));
	process.env.SUMMON_HOME = root;
	process.env.SUMMON_TEAMS_HOME = join(root, 'teams');
});
afterEach(async () => {
	if (previousRoot === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousRoot;
	if (previousTeams === undefined) delete process.env.SUMMON_TEAMS_HOME;
	else process.env.SUMMON_TEAMS_HOME = previousTeams;
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('summon-posix-'))
		throw new Error('Unexpected POSIX fixture directory.');
	await rm(root, { recursive: true, force: true });
});

posix('named teams and new room images are owner-only on a real POSIX filesystem', async () => {
	await selectTeamStorage(['fixture']);
	const team = join(root, 'teams', 'team-fixture');
	expect((await stat(join(root, 'teams'))).mode & 0o077).toBe(0);
	expect((await stat(team)).mode & 0o077).toBe(0);
	const id = await saveRoomImage(Buffer.from('Synthetic image bytes'));
	expect((await stat(join(team, 'room', 'images'))).mode & 0o077).toBe(0);
	expect((await stat(roomImagePath(id))).mode & 0o777).toBe(0o600);
});

posix(
	'configuration reads tighten existing modes without changing synthetic contents',
	async () => {
		const directory = join(root, 'integrations');
		await mkdir(directory);
		await chmod(directory, 0o755);
		const path = join(directory, 'telegram.json');
		const raw = JSON.stringify({ botToken: '1:fixture', chatId: '2' });
		await writeFile(path, raw);
		await chmod(path, 0o644);
		expect((await stat(path)).mode & 0o777).toBe(0o644);
		expect((await telegramConfig()).chatId).toBe('2');
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect(await readFile(path, 'utf8')).toBe(raw);
	},
);

posix(
	'configuration refuses redirected files and directories without changing their targets',
	async () => {
		const directory = join(root, 'integrations');
		await mkdir(directory);
		const target = join(root, 'outside');
		await writeFile(target, 'Synthetic non-credential content');
		await chmod(target, 0o644);
		await symlink(target, join(directory, 'telegram.json'));
		expect(await telegramConfig().catch(String)).toBe(
			'Error: Telegram configuration file permissions could not be restricted.',
		);
		expect((await stat(target)).mode & 0o777).toBe(0o644);
		await rm(join(directory, 'telegram.json'));
		await rmdir(directory);
		const outside = join(root, 'outside-directory');
		await mkdir(outside);
		await chmod(outside, 0o755);
		await symlink(outside, directory);
		expect(await telegramConfig().catch(String)).toContain(
			'permissions could not be restricted',
		);
		expect((await stat(outside)).mode & 0o777).toBe(0o755);
	},
);

posix('missing configuration retains the normal not-configured error', async () => {
	expect(await telegramConfig().catch(String)).toContain('Telegram is not configured');
});
