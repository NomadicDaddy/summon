import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as mailRead from '../src/mail-read.ts';
import { deliveryStatus } from '../src/mail-session.ts';
import { startMailWatcher } from '../src/mail-watcher.ts';
import { acknowledgeMessage, sendMessage } from '../src/mailbox.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previousHome = process.env.SUMMON_HOME;
const previousAgent = process.env.SUMMON_AGENT;
const previousNonce = process.env.SUMMON_NONCE;
const archivedId = '00000000-0000-4000-8000-000000000001';
const retainedId = '00000000-0000-4000-8000-000000000002';
const nonce = 'archive-race';

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previousHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousHome;
	if (previousAgent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previousAgent;
	if (previousNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previousNonce;
	await fixture.dispose();
});

async function waitForFirstScan(notices: string[]): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (notices.length || (await deliveryStatus('beta', nonce)).state === 'queued-only') return;
		await Bun.sleep(10);
	}
	throw new Error('First receiver scan did not complete.');
}

for (const provider of ['claude', 'codex', 'grok'] as const)
	test(`${provider} shared receiver skips mail archived between listing and opening`, async () => {
		await writeFile(
			join(fixture.records, 'beta.json'),
			JSON.stringify(newRecord('beta', fixture.root, provider)),
		);
		await sendMessage('alpha', 'beta', 'Archived private body', { id: archivedId });
		await sendMessage('alpha', 'beta', 'Retained private positive control', { id: retainedId });
		process.env.SUMMON_AGENT = 'beta';
		process.env.SUMMON_NONCE = nonce;
		const originalHeader = mailRead.header;
		let archived = false;
		const header = spyOn(mailRead, 'header').mockImplementation(async (name, id, archive) => {
			if (id === archivedId && !archived) {
				archived = true;
				await acknowledgeMessage(name, id);
			}
			return originalHeader(name, id, archive);
		});
		const notices: string[] = [];
		let stop: (() => Promise<void>) | undefined;
		try {
			stop = await startMailWatcher('beta', nonce, (text) => {
				notices.push(text);
				return Promise.resolve();
			});
			await waitForFirstScan(notices);
			expect(archived).toBe(true);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain(`summon --mail ready ${nonce}`);
			expect(notices[0]).not.toContain('private');
			expect((await deliveryStatus('beta', nonce)).state).toBe('unconfirmed');
			await stop();
			stop = undefined;
			const attempts = await fixture.read(`runtime/beta/${nonce}.attempts`);
			expect(attempts.split('\n')).toContain(retainedId);
			expect(attempts.split('\n')).not.toContain(archivedId);
			expect(
				await Bun.file(
					join(fixture.records, 'mailboxes/beta/archive', `${archivedId}.md`),
				).exists(),
			).toBe(true);
			expect(await fixture.read(`mailboxes/beta/inbox/${retainedId}.md`)).toContain(
				'Retained private positive control',
			);
			expect(await Bun.file(mailRead.statePath('beta', retainedId, 'read')).exists()).toBe(
				false,
			);
		} finally {
			await stop?.();
			header.mockRestore();
		}
	});

for (const failure of ['EACCES', 'malformed'] as const)
	test(`receiver still reports ${failure} and leaves mail unattempted`, async () => {
		await sendMessage('alpha', 'beta', 'Unread positive control', { id: retainedId });
		process.env.SUMMON_AGENT = 'beta';
		process.env.SUMMON_NONCE = nonce;
		if (failure === 'malformed')
			await writeFile(
				join(fixture.records, 'mailboxes/beta/inbox', `${retainedId}.md`),
				'malformed',
			);
		const header =
			failure === 'EACCES'
				? spyOn(mailRead, 'header').mockRejectedValue(
						Object.assign(new Error('Permission denied fixture'), { code: failure }),
					)
				: undefined;
		const notices: string[] = [];
		let stop: (() => Promise<void>) | undefined;
		try {
			stop = await startMailWatcher('beta', nonce, (text) => {
				notices.push(text);
				return Promise.resolve();
			});
			await waitForFirstScan(notices);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain('mailbox readiness');
			expect(notices[0]).not.toContain('Unread positive control');
			for (
				let attempt = 0;
				attempt < 100 && (await deliveryStatus('beta', nonce)).state !== 'queued-only';
				attempt++
			)
				await Bun.sleep(10);
			const status = await deliveryStatus('beta', nonce);
			expect(status.state).toBe('queued-only');
			expect(status.reason).toContain('Notification inventory could not be read');
			expect(status.reason).not.toContain('notification remains unsent');
			expect(
				await Bun.file(join(fixture.records, 'runtime/beta', `${nonce}.attempts`)).text(),
			).not.toContain(retainedId);
			expect(await Bun.file(mailRead.statePath('beta', retainedId, 'read')).exists()).toBe(
				false,
			);
		} finally {
			await stop?.();
			header?.mockRestore();
		}
	});
