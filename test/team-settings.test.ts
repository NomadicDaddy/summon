import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localRoomPath } from '../src/local-room.ts';
import { readTeamSettings, readWakeOnMention, saveTeamSettings } from '../src/team-settings.ts';

const previousRoot = process.env.SUMMON_HOME;
let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-test-'));
	process.env.SUMMON_HOME = root;
});
afterEach(async () => {
	if (previousRoot === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousRoot;
	await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
});
const delivery = () => join(root, 'settings', 'claude-delivery.json');
const window = () => join(root, 'runtime', 'team-window', 'settings.json');
const autoDefaults = { autoHeadDown: false, autoHeadDownRevision: 0 };

// The Team Window reads and changes Claude delivery through the settings it already has.
describe('team settings carry Claude delivery', () => {
	test('a team with neither file reads the defaults it always had', async () => {
		expect(await readTeamSettings()).toEqual({
			...autoDefaults,
			autoHold: true,
			claudeDelivery: 'live',
			holdSeconds: 30,
			wakeOnMention: true,
		});
	});

	test('changing one setting leaves the other as it was', async () => {
		expect(await saveTeamSettings({ wakeOnMention: false })).toEqual({
			...autoDefaults,
			autoHold: true,
			claudeDelivery: 'live',
			holdSeconds: 30,
			wakeOnMention: false,
		});
		expect(await Bun.file(delivery()).exists()).toBe(false);
		expect(await saveTeamSettings({ claudeDelivery: 'checkpoint' })).toEqual({
			...autoDefaults,
			autoHold: true,
			claudeDelivery: 'checkpoint',
			holdSeconds: 30,
			wakeOnMention: false,
		});
		expect(JSON.parse(await readFile(delivery(), 'utf8'))).toEqual({
			version: 1,
			mode: 'checkpoint',
		});
		// The window's own file keeps its one key, so an older build still reads it.
		expect(JSON.parse(await readFile(window(), 'utf8'))).toEqual({ wakeOnMention: false });
	});

	test('mention scans read their setting without validating the auto grant audit', async () => {
		await saveTeamSettings({ autoHeadDown: true });
		await saveTeamSettings({ wakeOnMention: false });
		await writeFile(localRoomPath(), '{bad json');
		expect(await readWakeOnMention()).toBe(false);
		await writeFile(window(), JSON.stringify({ wakeOnMention: true }));
		expect(await readWakeOnMention()).toBe(true);
	});

	// The automatic hold preference (Phillip #7266) shares the window file with the mention switch.
	test('the hold settings merge into the window file beside the keys already there', async () => {
		await saveTeamSettings({ wakeOnMention: false });
		expect(await saveTeamSettings({ holdSeconds: 45 })).toEqual({
			...autoDefaults,
			autoHold: true,
			claudeDelivery: 'live',
			holdSeconds: 45,
			wakeOnMention: false,
		});
		expect(JSON.parse(await readFile(window(), 'utf8'))).toEqual({
			holdSeconds: 45,
			wakeOnMention: false,
		});
		expect(await saveTeamSettings({ autoHold: false })).toEqual({
			...autoDefaults,
			autoHold: false,
			claudeDelivery: 'live',
			holdSeconds: 45,
			wakeOnMention: false,
		});
		// A file written by an older build, with only the mention key, reads with the defaults.
		await writeFile(window(), JSON.stringify({ wakeOnMention: true }));
		expect(await readTeamSettings()).toEqual({
			...autoDefaults,
			autoHold: true,
			claudeDelivery: 'live',
			holdSeconds: 30,
			wakeOnMention: true,
		});
	});

	test('concurrent partial saves keep each other and the keys already stored', async () => {
		await saveTeamSettings({ wakeOnMention: false });
		await Promise.all([
			saveTeamSettings({ autoHold: false }),
			saveTeamSettings({ holdSeconds: 45 }),
			saveTeamSettings({ claudeDelivery: 'checkpoint' }),
		]);
		expect(JSON.parse(await readFile(window(), 'utf8'))).toEqual({
			autoHold: false,
			holdSeconds: 45,
			wakeOnMention: false,
		});
		expect(await readTeamSettings()).toEqual({
			...autoDefaults,
			autoHold: false,
			claudeDelivery: 'checkpoint',
			holdSeconds: 45,
			wakeOnMention: false,
		});
	});

	test('a refused change writes neither setting', async () => {
		for (const value of [
			{},
			{ claudeDelivery: 'sometimes' },
			{ claudeDelivery: 'checkpoint', wakeOnMention: 'no' },
			{ claudeDelivery: 'checkpoint', other: true },
			{ autoHold: 'yes' },
			{ holdSeconds: 4 },
			{ holdSeconds: 601 },
			{ holdSeconds: 2.5 },
			{ holdSeconds: '30' },
			{ holdSeconds: Number.NaN },
		]) {
			let refused = false;
			try {
				await saveTeamSettings(value);
			} catch {
				refused = true;
			}
			expect(refused).toBe(true);
		}
		expect(await Bun.file(delivery()).exists()).toBe(false);
		expect(await Bun.file(window()).exists()).toBe(false);
	});

	test('a teammate session cannot change the setting', async () => {
		await mkdir(join(root, 'settings'));
		await writeFile(delivery(), JSON.stringify({ version: 1, mode: 'live' }));
		process.env.SUMMON_AGENT = 'member';
		try {
			let refused = false;
			try {
				await saveTeamSettings({ claudeDelivery: 'checkpoint' });
			} catch {
				refused = true;
			}
			expect(refused).toBe(true);
		} finally {
			delete process.env.SUMMON_AGENT;
		}
		expect(JSON.parse(await readFile(delivery(), 'utf8'))).toEqual({
			version: 1,
			mode: 'live',
		});
	});
});
