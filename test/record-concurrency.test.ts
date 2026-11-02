import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { locked } from '../src/mail-files.ts';
import { runtimePath } from '../src/mail-session.ts';
import { removeAgent } from '../src/remove.ts';
import {
	latestSession,
	loadAgent,
	newRecord,
	notesPath,
	recordPath,
	rememberSession,
	saveAgent,
	updateAgentRecord,
} from '../src/store.ts';
import { profileFor, saveProfile } from '../src/team-maintenance.ts';
import { cliHarness } from './fixtures/cli-harness.ts';

test('session allocation retains profile edits made while the provider creates its ID', async () => {
	const fixture = await cliHarness();
	try {
		await writeFile(
			join(fixture.records, 'member.json'),
			JSON.stringify(newRecord('Member', fixture.project, 'kilo')),
		);
		const result = await fixture.invoke(['__session', 'member'], {
			SUMMON_TEST_EDIT_DURING_ALLOCATION: '1',
		});
		expect(result.code).toBe(0);
		const record = await fixture.saved();
		expect(record.domain).toBe('Operator changed domain during allocation');
		expect(record.expertise).toBe('Operator changed expertise during allocation');
		expect(latestSession(record)?.id).toStartWith('ses_');
	} finally {
		await fixture.dispose();
	}
});

test('profile and cover cleanup preserve concurrent session changes; create refuses replacement', async () => {
	const fixture = await cliHarness();
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = fixture.records;
	try {
		const record = newRecord('Member', fixture.project, 'codex');
		rememberSession(record, 'original');
		record.backup = 'Cover';
		await saveAgent('member', record);
		await saveAgent('cover', newRecord('Cover', fixture.project, 'claude'));
		const profile = await profileFor('member');
		await Promise.all([
			saveProfile({ ...profile, domain: 'Edited domain' }, 'member'),
			updateAgentRecord('member', (current) => rememberSession(current, 'concurrent')),
		]);
		let current = await loadAgent('member');
		expect(current?.domain).toBe('Edited domain');
		expect(current?.sessions.map((session) => session.id)).toContain('concurrent');
		// Hold the notes lock so the form must wait while another writer updates its record.
		const fresh = await profileFor('member');
		let saving: Promise<string> | undefined;
		await locked(`${notesPath('member')}.lock`, async () => {
			saving = saveProfile({ ...fresh, expertise: 'Edited expertise' }, 'member');
			const profileLock = join(runtimePath('member'), 'profile.lock');
			for (let attempt = 0; !(await Bun.file(profileLock).exists()); attempt++) {
				if (attempt === 100) throw new Error('Profile did not reach its notes lock.');
				await delay(10);
			}
			await updateAgentRecord('member', (value) => rememberSession(value, 'newest'));
		});
		await saving;
		current = await loadAgent('member');
		expect(current?.expertise).toBe('Edited expertise');
		expect(current && latestSession(current)?.id).toBe('newest');
		await Promise.all([
			removeAgent('cover'),
			updateAgentRecord('member', (value) => rememberSession(value, 'during-removal')),
		]);
		current = await loadAgent('member');
		expect(current?.backup).toBeUndefined();
		expect(current?.sessions.map((session) => session.id)).toContain('during-removal');
		const before = await Bun.file(recordPath('member')).text();
		let failure: unknown;
		await saveAgent('member', record, true).catch((error: unknown) => {
			failure = error;
		});
		expect(String(failure)).toContain('already exists');
		expect(await Bun.file(recordPath('member')).text()).toBe(before);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await fixture.dispose();
	}
});
