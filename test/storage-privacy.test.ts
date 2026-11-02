import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { messageBodyArgs } from '../src/message-body-file.ts';
import { storageRoot, teamLabel } from '../src/storage-root.ts';

const previous = {
	SUMMON_HOME: process.env.SUMMON_HOME,
	SUMMON_TEAMS_HOME: process.env.SUMMON_TEAMS_HOME,
	SUMMON_AGENT: process.env.SUMMON_AGENT,
	SUMMON_NONCE: process.env.SUMMON_NONCE,
};
let fixture: string;
let base: string;
let selected: string;

beforeEach(async () => {
	fixture = await mkdtemp(join(tmpdir(), 'summon-storage-privacy-'));
	base = join(fixture, 'teams');
	selected = join(base, 'team-default');
	await mkdir(selected, { recursive: true });
	process.env.SUMMON_HOME = selected;
	process.env.SUMMON_TEAMS_HOME = base;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'storage-privacy-fixture';
});
afterEach(async () => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = value;
	}
	if (
		dirname(resolve(fixture)) !== resolve(tmpdir()) ||
		!basename(fixture).startsWith('summon-storage-privacy-')
	)
		throw new Error('Unexpected privacy fixture cleanup root');
	await rm(fixture, { recursive: true, force: true });
});

async function file(path: string): Promise<string> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, 'fixture body Ω');
	return path;
}

test('default subfolder keeps own file input and rejects same-slug private files in another team', async () => {
	const own = await file(join(selected, 'scratch/alpha/body.txt'));
	expect(await messageBodyArgs(['--body-file', own], 0)).toEqual(['fixture body Ω']);
	for (const path of [
		join(selected, 'scratch/beta/private.txt'),
		join(selected, 'mailboxes/beta/inbox/private.txt'),
		join(base, 'team-other/runtime/alpha/private.txt'),
		join(base, 'team-other/scratch/alpha/private.txt'),
	]) {
		await file(path);
		await rejects(messageBodyArgs(['--body-file', path], 0), /private storage/);
	}
});

test('a public-looking link cannot redirect file-body input to another team private file', async () => {
	const target = await file(join(base, 'team-other/scratch/alpha/private.txt'));
	const redirect = join(selected, 'shared-looking');
	await symlink(dirname(target), redirect, process.platform === 'win32' ? 'junction' : 'dir');
	await rejects(
		messageBodyArgs(['--body-file', join(redirect, 'private.txt')], 0),
		/private storage/,
	);
});

test('only the actual default-team identity hides its label; custom roots are never appended', () => {
	expect(teamLabel()).toBeUndefined();
	process.env.SUMMON_HOME = join(base, 'team-testing');
	expect(teamLabel()).toBe('testing');
	const custom = join(fixture, 'unrelated', 'team-default');
	process.env.SUMMON_HOME = custom;
	expect(storageRoot()).toBe(custom);
	expect(teamLabel()).toBe('default');
});
