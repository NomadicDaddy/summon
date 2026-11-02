import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
	applyClaudeConfig,
	claudeConfigDirectory,
	claudeEnvironment,
} from '../src/claude-config.ts';
import { teamSnapshot } from '../src/desktop/team-snapshot.ts';
import { readProviderModel } from '../src/provider-model-info.ts';
import { acquireSessionLock } from '../src/session-lock.ts';
import {
	forgetSession,
	latestSession,
	loadAgent,
	newRecord,
	rememberSession,
	saveAgent,
	updateAgentRecord,
} from '../src/store.ts';
import { profileFor, saveProfile } from '../src/team-maintenance.ts';
import { cliHarness } from './fixtures/cli-harness.ts';

let fixture: Awaited<ReturnType<typeof cliHarness>>;
let first: string, second: string;
const previous = {
	home: process.env.SUMMON_HOME,
	claude: process.env.CLAUDE_CONFIG_DIR,
	agent: process.env.SUMMON_AGENT,
};
beforeEach(async () => {
	fixture = await cliHarness();
	first = join(fixture.root, 'first account');
	second = join(fixture.root, 'second account');
	await mkdir(first);
	await mkdir(second);
	process.env.SUMMON_HOME = fixture.records;
	process.env.CLAUDE_CONFIG_DIR = first;
});
afterEach(async () => {
	for (const [key, value] of [
		['SUMMON_HOME', previous.home],
		['CLAUDE_CONFIG_DIR', previous.claude],
		['SUMMON_AGENT', previous.agent],
	] as const) {
		if (value === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = value;
	}
	await fixture.dispose();
});

test('operator switches accounts without reusing or discarding either conversation', async () => {
	await fixture.seed('claude');
	const original = await profileFor('member');
	const bytes = await readFile(join(fixture.records, 'member.json'), 'utf8');
	expect(saveProfile({ ...original, claudeConfigDir: second }, 'member')).rejects.toThrow(
		'Clear the session ID',
	);
	expect(await readFile(join(fixture.records, 'member.json'), 'utf8')).toBe(bytes);
	const lock = await acquireSessionLock('member');
	try {
		expect(
			saveProfile({ ...original, claudeConfigDir: second, sessionId: '' }, 'member'),
		).rejects.toThrow('Stop this teammate');
	} finally {
		await lock?.release();
	}
	await saveProfile({ ...original, claudeConfigDir: second, sessionId: '' }, 'member');
	expect((await profileFor('member')).sessionId).toBe('');
	await updateAgentRecord('member', (record) => rememberSession(record, 'second-session'));
	const changed = await profileFor('member');
	expect(changed.sessionId).toBe('second-session');
	await saveProfile({ ...changed, claudeConfigDir: '', sessionId: '' }, 'member');
	expect((await profileFor('member')).sessionId).toBe('existing-session');
	await saveProfile(
		{ ...(await profileFor('member')), claudeConfigDir: second, sessionId: '' },
		'member',
	);
	expect((await profileFor('member')).sessionId).toBe('second-session');
	expect((await loadAgent('member'))?.sessions).toHaveLength(2);
});

test('account-scoped equal IDs cannot overwrite or forget another account', () => {
	const record = newRecord('member', fixture.project, 'claude');
	rememberSession(record, 'same-id');
	applyClaudeConfig(record, second);
	expect(latestSession(record)).toBeUndefined();
	rememberSession(record, 'same-id');
	expect(record.sessions).toHaveLength(2);
	forgetSession(record, 'same-id');
	expect(latestSession(record)).toBeUndefined();
	applyClaudeConfig(record, undefined);
	expect(latestSession(record)?.id).toBe('same-id');
});

test('bad directories and non-Claude assignments fail before writes; member saves cannot change the operator selection', async () => {
	const original = await fixture.seed('claude');
	const profile = await profileFor('member');
	for (const directory of ['relative', join(fixture.root, 'missing'), `${second}\0`, 123])
		expect(
			saveProfile({ ...profile, claudeConfigDir: directory, sessionId: '' }, 'member'),
		).rejects.toThrow();
	expect(await fixture.saved()).toEqual(original);
	await saveProfile({ ...profile, claudeConfigDir: second, sessionId: '' }, 'member');
	// The selection is stored as the folder's real path, which differs from a short-form TEMP.
	const saved = await realpath(second);
	const selected = await loadAgent('member');
	if (!selected) throw new Error('fixture missing');
	process.env.SUMMON_AGENT = 'member';
	await updateAgentRecord('member', (record) => {
		record.claudeConfigDir = first;
	});
	expect((await loadAgent('member'))?.claudeConfigDir).toBe(saved);
	selected.claudeConfigDir = first;
	await saveAgent('member', selected);
	expect((await loadAgent('member'))?.claudeConfigDir).toBe(saved);
	delete process.env.SUMMON_AGENT;
	for (const provider of ['codex', 'grok', 'kilo'] as const) {
		const record = newRecord('other', fixture.project, provider);
		expect(claudeEnvironment(record)).toBe(process.env);
		expect(
			saveProfile(
				{
					...profile,
					name: 'other',
					notesRevision: null,
					profileRevision: null,
					sessionId: '',
					provider,
					claudeConfigDir: second,
				},
				null,
			),
		).rejects.toThrow('requires Claude');
	}
});

test('actual CLI launches use selected root and resume only its conversation, in both delivery modes', async () => {
	await fixture.seed('claude');
	await saveProfile(
		{ ...(await profileFor('member')), claudeConfigDir: second, sessionId: '' },
		'member',
	);
	const fresh = await fixture.invoke(['__session', 'member', '--claude-checkpoint'], {
		CLAUDE_CONFIG_DIR: first,
	});
	expect(fresh.code).toBe(0);
	const saved = await realpath(second);
	expect(fresh.launches[0]?.claudeConfigDir).toBe(saved);
	expect(fresh.launches[0]?.cmd).toContain('--session-id');
	expect(fresh.launches[0]?.cmd).not.toContain('existing-session');
	const id = latestSession(await fixture.saved())?.id;
	if (!id) throw new Error('Expected the new account conversation.');
	const resumed = await fixture.invoke(['member', '--same-window', '--claude-mail-channel'], {
		CLAUDE_CONFIG_DIR: first,
	});
	expect(resumed.code).toBe(0);
	expect(resumed.launches[0]?.claudeConfigDir).toBe(saved);
	expect(resumed.launches[0]?.cmd.slice(0, 3)).toEqual(['claude', '--resume', id]);
	expect(resumed.launches[0]?.cmd).not.toContain('--dangerously-skip-permissions');
});

test('model discovery and roster label use the selected root, even with identical IDs in two roots', async () => {
	const record = newRecord('member', fixture.project, 'claude');
	record.claudeConfigDir = second;
	rememberSession(record, 'same-id');
	for (const [root, model] of [
		[first, 'wrong-account'],
		[second, 'selected-account'],
	] as const) {
		const project = join(root, 'projects', 'original-workspace');
		await mkdir(project, { recursive: true });
		await writeFile(
			join(project, 'same-id.jsonl'),
			JSON.stringify({
				type: 'assistant',
				sessionId: 'same-id',
				message: { model, content: 'private fixture body' },
			}),
		);
	}
	await saveAgent('member', record);
	await writeFile(join(fixture.records, 'member.md'), '');
	expect((await readProviderModel(record))?.model).toBe('selected-account');
	const snapshot = await teamSnapshot({
		sessions: new Map(),
		reported: new Set(),
		emit: () => {},
		startedAt: '',
		selected: '',
	});
	expect(snapshot.agents[0]?.claudeConfigDir).toBe(claudeConfigDirectory(record));
	expect(snapshot.agents[0]?.modelInfo?.model).toBe('selected-account');
	expect(JSON.stringify(snapshot)).not.toContain('private fixture body');
});
