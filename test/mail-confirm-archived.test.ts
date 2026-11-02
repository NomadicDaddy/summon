import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { confirmMessage } from '../src/mail-read.ts';
import { sendMessage } from '../src/mailbox.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

// Alice's report f2a7f61b (Morgan c7a0f4b6): confirming mail already acknowledged into the archive
// raised a raw inbox ENOENT. Each case is refused with what happened to the mail, and writes nothing.

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const originalRoot = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (originalRoot === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = originalRoot;
	await fixture.dispose();
});

const mailbox = (name: string, folder: string): Promise<string[]> =>
	readdir(join(fixture.records, 'mailboxes', name, folder)).catch(() => []);
const confirmedState = (id: string): Promise<string | null> =>
	readFile(
		join(fixture.records, 'mailboxes', 'alpha', 'delivery', `${id}.confirmed`),
		'utf8',
	).catch(() => null);

async function readAll(id: string): Promise<void> {
	const run = await fixture.run(
		['--mail', 'read-self', id, '--offset', '0', '--limit', '32768'],
		'alpha',
	);
	expect(run.code).toBe(0);
}

async function ack(id: string): Promise<void> {
	expect((await fixture.run(['--mail', 'ack-self', id], 'alpha')).code).toBe(0);
	expect(await mailbox('alpha', 'archive')).toContain(`${id}.md`);
}

/** Confirms as alpha, asserting a plain refusal that sent and recorded nothing; returns it. */
async function refused(id: string): Promise<string> {
	const [sent, confirmed] = await Promise.all([mailbox('beta', 'inbox'), confirmedState(id)]);
	const run = await fixture.run(['--mail', 'confirm', id, 'understood'], 'alpha');
	expect(run.code).toBe(1);
	expect(run.error).not.toContain('ENOENT');
	expect(await mailbox('beta', 'inbox')).toEqual(sent);
	expect(await confirmedState(id)).toBe(confirmed);
	return run.error;
}

test('confirming a request acknowledged without confirmation says it was archived unconfirmed', async () => {
	const id = await sendMessage('beta', 'alpha', 'Please confirm this request.');
	await readAll(id);
	await ack(id);
	const message = await refused(id);
	expect(message).toContain(`Message ${id} is archived with no recorded confirmation`);
	expect(message).toContain('this command sent none');
});

test('confirming a request again after it was confirmed and archived names the confirmation', async () => {
	const id = await sendMessage('beta', 'alpha', 'Please confirm this request.');
	await readAll(id);
	expect((await fixture.run(['--mail', 'confirm', id, 'understood'], 'alpha')).code).toBe(0);
	const confirmation = await confirmedState(id);
	expect(confirmation).toBeTruthy();
	await ack(id);
	expect(await refused(id)).toContain(
		`Message ${id} is archived and was already confirmed (${String(confirmation)}).`,
	);
});

test('confirming an id in neither the inbox nor the archive says so', async () => {
	const id = '00000000-0000-4000-8000-000000000000';
	expect(await refused(id)).toContain(
		`Message ${id} is not in your inbox or archive; this command sent no confirmation.`,
	);
});

test('a malformed id keeps its own error rather than an archive diagnostic', async () => {
	const run = await fixture.run(['--mail', 'confirm', 'not-a-uuid', 'understood'], 'alpha');
	expect(run.code).toBe(1);
	expect(run.error).toContain('A message ID must be a UUID.');
	expect(run.error).not.toContain('archive');
});

/** Calls confirmMessage for alpha's mailbox from beta's session; returns the refusal text. */
async function confirmAsBeta(id: string): Promise<string> {
	const [agent, nonce] = [process.env.SUMMON_AGENT, process.env.SUMMON_NONCE];
	process.env.SUMMON_AGENT = 'beta';
	process.env.SUMMON_NONCE = 'test-launch';
	try {
		return await confirmMessage('alpha', id, 'understood').then(
			() => 'confirmed',
			(error: unknown) => String(error),
		);
	} finally {
		if (agent === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = agent;
		if (nonce === undefined) delete process.env.SUMMON_NONCE;
		else process.env.SUMMON_NONCE = nonce;
	}
}

async function archivedRequest(): Promise<string> {
	const id = await sendMessage('beta', 'alpha', 'Please confirm this request.');
	await readAll(id);
	await ack(id);
	return id;
}

test("a coverer confirming the covered teammate's archived mail is refused before any archive check", async () => {
	const record = JSON.parse(await fixture.read('alpha.json')) as Record<string, unknown>;
	await writeFile(
		join(fixture.records, 'alpha.json'),
		JSON.stringify({ ...record, backup: 'beta' }),
	);
	const id = await archivedRequest();
	const error = await confirmAsBeta(id);
	expect(error).toContain('Agents may access only their own mailbox');
	expect(error).not.toContain('archive');
	expect(await confirmedState(id)).toBeNull();
});

test('a teammate not recorded as cover keeps the existing inbox refusal', async () => {
	const id = await archivedRequest();
	const error = await confirmAsBeta(id);
	expect(error).toContain(
		'Another inbox is readable only by the teammate recorded as covering it.',
	);
	expect(error).not.toContain('ENOENT');
	expect(await confirmedState(id)).toBeNull();
});
