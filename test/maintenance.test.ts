import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readChunk } from '../src/mail-read.ts';
import { acknowledgeMessage, pendingMessages, sendMessage } from '../src/mailbox.ts';
import { removeAgent } from '../src/remove.ts';
import { acquireSessionLock } from '../src/session-lock.ts';
import { loadAgent, saveAgent } from '../src/store.ts';
import { profileFor, saveProfile, type TeamProfile } from '../src/team-maintenance.ts';
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
const rejected = async (work: Promise<unknown>, text: string): Promise<void> => {
	expect(await work.catch((error: unknown) => String(error))).toContain(text);
};
test('maintenance creates and edits complete profiles without launching, preserves CLI and known IDs', async () => {
	const profile: TeamProfile = {
		memberType: 'teammate',
		canStopResting: false,
		displayName: 'ember',
		name: 'ember',
		provider: 'codex',
		cwd: fixture.root,
		expertise: 'Testing',
		domain: 'Fixtures',
		backup: '',
		notes: 'Keep notes',
		notesRevision: null,
		profileRevision: null,
		sessionId: 'known-session',
	};
	expect(await saveProfile(profile, null)).toBe('ember');
	profile.notesRevision = (await profileFor('ember')).notesRevision;
	profile.profileRevision = (await profileFor('ember')).profileRevision;
	profile.kiloSettingsRevision = (await profileFor('ember')).kiloSettingsRevision ?? null;
	expect(await profileFor('ember')).toEqual(profile);
	await rejected(
		saveProfile({ ...profile, notesRevision: null, profileRevision: null }, null),
		'already exists',
	);
	await rejected(
		saveProfile({ ...profile, provider: 'claude' }, 'ember'),
		'keeps its registered CLI',
	);
	await rejected(saveProfile({ ...profile, sessionId: '' }, 'ember'), 'Keep the saved');
	await rejected(
		saveProfile({ ...profile, sessionId: '../other' }, 'ember'),
		'plain provider identifier',
	);
	await saveProfile(
		{ ...profile, notes: 'Updated notes', sessionId: 'another-session' },
		'ember',
	);
	expect((await profileFor('ember')).sessionId).toBe('another-session');
	const lock = await acquireSessionLock('ember');
	try {
		await rejected(saveProfile(profile, 'ember'), 'Stop this teammate');
	} finally {
		await lock?.release();
	}
	expect(await readFile(fixture.capture, 'utf8')).toBe('');
});
test('archive saves profile notes icon and own mailbox while retaining other recipients mail', async () => {
	await writeFile(join(fixture.records, 'alpha.md'), 'Durable notes');
	await writeFile(join(fixture.records, 'alpha.png'), 'Icon');
	const own = await sendMessage('beta', 'alpha', 'Own mail');
	const sent = await sendMessage('alpha', 'beta', 'Keep at recipient');
	await removeAgent('alpha', true);
	const entries = await readdir(join(fixture.records, 'archives'));
	expect(entries).toHaveLength(1);
	const archive = join(fixture.records, 'archives', entries[0] ?? 'missing');
	expect(await readFile(join(archive, 'alpha.md'), 'utf8')).toBe('Durable notes');
	expect(await readFile(join(archive, 'alpha.png'), 'utf8')).toBe('Icon');
	expect(await readFile(join(archive, 'mailbox', 'inbox', `${own}.md`), 'utf8')).toContain(
		'Own mail',
	);
	expect(
		await readFile(join(fixture.records, 'mailboxes', 'beta', 'inbox', `${sent}.md`), 'utf8'),
	).toContain('Keep at recipient');
	expect(await Bun.file(join(fixture.records, 'alpha.json')).exists()).toBe(false);
});
test('only another registered teammate can cover one, and removal clears the reference', async () => {
	const profile: TeamProfile = {
		name: 'ember',
		provider: 'codex',
		cwd: fixture.root,
		expertise: 'Testing',
		domain: 'Fixtures',
		backup: 'alpha',
		notes: '',
		notesRevision: null,
		profileRevision: null,
		sessionId: '',
	};
	await rejected(saveProfile({ ...profile, backup: 'nobody' }, null), 'registered teammate');
	await rejected(saveProfile({ ...profile, backup: 'ember' }, null), 'cannot cover itself');
	// Cover must survive a provider outage, so a coverer on the same CLI is refused. The harness
	// registers alpha and beta as claude, so a claude teammate naming either one is the live case.
	await rejected(
		saveProfile({ ...profile, provider: 'claude', backup: 'alpha' }, null),
		'must run a different CLI',
	);
	expect(await saveProfile(profile, null)).toBe('ember');
	profile.notesRevision = (await profileFor('ember')).notesRevision;
	profile.profileRevision = (await profileFor('ember')).profileRevision;
	expect((await profileFor('ember')).backup).toBe('alpha');
	// Stored as the registered spelling rather than whatever was typed, so the name always resolves.
	await saveProfile({ ...profile, backup: 'ALPHA' }, 'ember');
	expect((await profileFor('ember')).backup).toBe('alpha');
	// Cover cannot outlive the registration it names.
	await removeAgent('alpha');
	expect((await profileFor('ember')).backup).toBe('');
	// Clearing one reference leaves every other record alone.
	await saveProfile({ ...profile, backup: 'beta' }, 'ember');
	await saveProfile({ ...profile, name: 'beta', provider: 'claude', backup: '' }, 'beta');
	expect((await profileFor('ember')).backup).toBe('beta');
});

test('a running teammate still accepts profile edits, and refuses only a session rebind', async () => {
	const profile: TeamProfile = {
		name: 'ember',
		provider: 'codex',
		cwd: fixture.root,
		expertise: 'Testing',
		domain: 'Fixtures',
		backup: '',
		notes: '',
		notesRevision: null,
		profileRevision: null,
		sessionId: 'known-session',
	};
	await saveProfile(profile, null);
	profile.notesRevision = (await profileFor('ember')).notesRevision;
	profile.profileRevision = (await profileFor('ember')).profileRevision;
	// Hold the session lock: the teammate is running as far as everything else is concerned.
	const lock = await acquireSessionLock('ember');
	try {
		// Prompt-only fields are read at launch and never written by the live session, so these
		// must succeed rather than demand a restart. This is the whole point of the change.
		await saveProfile(
			{ ...profile, domain: 'Edited while running', backup: 'alpha', notes: 'New notes' },
			'ember',
		);
		const saved = await profileFor('ember');
		expect(saved.domain).toBe('Edited while running');
		expect(saved.backup).toBe('alpha');
		expect(saved.notes).toBe('New notes');
		// The session list is untouched by the edit, which is what the lock existed to protect.
		expect(saved.sessionId).toBe('known-session');
		// Rebinding the session is the one edit that still needs the teammate stopped.
		await rejected(
			saveProfile({ ...profile, sessionId: 'a-different-session' }, 'ember'),
			'session ID',
		);
	} finally {
		await lock?.release();
	}
});

test('a recorded coverer may read the covered inbox, and may do nothing else with it', async () => {
	const id = await sendMessage('alpha', 'beta', 'Something beta must answer.');
	// beta records alpha as its cover.
	const beta = await loadAgent('beta');
	if (!beta) throw new Error('fixture missing beta');
	beta.backup = 'alpha';
	await saveAgent('beta', beta);
	const prior = process.env.SUMMON_AGENT;
	const priorNonce = process.env.SUMMON_NONCE;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'launch-one';
	try {
		// The whole point: cover can see what is waiting on the teammate it covers.
		expect(await pendingMessages('beta')).toContain(`${id}.md`);
		expect((await readChunk('beta', id)).text).toContain('Something beta must answer.');
		// And nothing else. These are the call sites a wider gate would have handed over.
		await rejected(sendMessage('beta', 'alpha', 'Impersonation'), 'only their own mailbox');
		await rejected(acknowledgeMessage('beta', id), 'only their own mailbox');
		// A teammate that is not recorded as cover gets nothing.
		process.env.SUMMON_AGENT = 'ember';
		await rejected(pendingMessages('beta'), 'does not record you as cover');
	} finally {
		if (prior === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = prior;
		if (priorNonce === undefined) delete process.env.SUMMON_NONCE;
		else process.env.SUMMON_NONCE = priorNonce;
	}
});
