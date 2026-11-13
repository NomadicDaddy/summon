import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { header, readIndexedChunk, readListedMail } from '../src/mail-read-index.ts';
import { acknowledgeMessage, sendMessage } from '../src/mailbox.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previousHome = process.env.SUMMON_HOME;
const previousAgent = process.env.SUMMON_AGENT;

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	delete process.env.SUMMON_AGENT;
});

afterEach(async () => {
	if (previousHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousHome;
	if (previousAgent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previousAgent;
	await fixture.dispose();
});

function mailPath(folder: 'inbox' | 'archive', id: string): string {
	return join(fixture.records, 'mailboxes', 'beta', folder, `${id}.md`);
}

test('a listed ordinary message archived before header open is no longer pending', async () => {
	const movedId = randomUUID();
	const liveId = randomUUID();
	await sendMessage('alpha', 'beta', 'Moved body', { id: movedId });
	await sendMessage('alpha', 'beta', 'Still pending', { id: liveId });
	await acknowledgeMessage('beta', movedId);

	const index = await readListedMail('beta', [`${movedId}.md`, `${liveId}.md`]);
	expect(index.errors).toEqual([]);
	expect(index.mails.map((mail) => mail.id)).toEqual([liveId]);
});

test('a listed message absent from both folders remains an inventory error', async () => {
	const id = randomUUID();
	const index = await readListedMail('beta', [`${id}.md`]);
	expect(index.mails).toEqual([]);
	expect(index.errors).toHaveLength(1);
	expect(index.errors[0]?.id).toBe(id);
});

test('a malformed archive does not justify skipping a listed message', async () => {
	const id = randomUUID();
	await sendMessage('alpha', 'beta', 'Archived body', { id });
	await acknowledgeMessage('beta', id);
	await writeFile(mailPath('archive', id), 'malformed');
	const index = await readListedMail('beta', [`${id}.md`]);
	expect(index.mails).toEqual([]);
	expect(index.errors[0]?.error).toContain('Malformed message header');
});

test('an indexed body continues from the same message after an archive move', async () => {
	const id = randomUUID();
	await sendMessage('alpha', 'beta', 'Body after archive', { id });
	const indexed = await header('beta', id);
	const original = await readFile(mailPath('inbox', id), 'utf8');
	await acknowledgeMessage('beta', id);
	const first = await readIndexedChunk('beta', indexed, 0, 16);
	const rest = await readIndexedChunk('beta', indexed, first.end);
	expect(first.text + rest.text).toBe(original);
	expect(rest.size).toBe(indexed.size);
});

test('an indexed body refuses a changed archived header', async () => {
	const id = randomUUID();
	await sendMessage('alpha', 'beta', 'Body after archive', { id });
	const indexed = await header('beta', id);
	await acknowledgeMessage('beta', id);
	const archived = await readFile(mailPath('archive', id), 'utf8');
	await writeFile(
		mailPath('archive', id),
		archived.replace(/^Sent: .*$/m, 'Sent: 2030-01-01T00:00:00.000Z'),
	);
	const error = await readIndexedChunk('beta', indexed).catch((error: unknown) => error);
	expect(error).toBeInstanceOf(Error);
	expect(String(error)).toContain('Archived mail changed');
});
