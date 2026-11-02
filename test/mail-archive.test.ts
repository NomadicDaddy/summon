import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MailArchiveConflictError } from '../src/mail-archive.ts';
import { holdMessage } from '../src/mail-attention.ts';
import { errorCode } from '../src/mail-files.ts';
import { confirmMessage, recordRead } from '../src/mail-read.ts';
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

const path = (folder: 'inbox' | 'archive', id: string, name = 'beta') =>
	join(fixture.records, 'mailboxes', name, folder, `${id}.md`);

async function sent(text = 'First body', id = randomUUID()) {
	await sendMessage('alpha', 'beta', text, { id });
	return { id, body: await readFile(path('inbox', id), 'utf8') };
}

/**
 * A send that reuses an archived ID with different content is refused at the sender, so a
 * conflicting inbox copy can only arrive another way (an older build, a crash, a hand-placed
 * file). Prove the refusal, then plant that copy directly.
 */
async function conflictingCopy(id: string, from: string, to: string) {
	expect(
		await sendMessage('alpha', 'beta', to, { id }).catch((error: unknown) => error),
	).toBeInstanceOf(Error);
	const archived = await readFile(path('archive', id), 'utf8');
	await writeFile(path('inbox', id), archived.replace(from, to), { flag: 'wx' });
}

async function collision() {
	const first = await sent();
	await acknowledgeMessage('beta', first.id);
	await conflictingCopy(first.id, 'First body', 'Different body');
	return first;
}

test('ordinary and repeated acknowledgements retain the exact first archive bytes', async () => {
	const { id, body } = await sent();
	await acknowledgeMessage('beta', id);
	await acknowledgeMessage('beta', id);
	expect(await readFile(path('archive', id), 'utf8')).toBe(body);
	expect(await readdir(join(fixture.records, 'mailboxes', 'beta', 'inbox'))).toEqual([]);
});

test('fresh-ID control preserves two distinct archived messages', async () => {
	const first = await sent();
	const second = await sent('Second body');
	await acknowledgeMessage('beta', first.id);
	await acknowledgeMessage('beta', second.id);
	expect(first.id).not.toBe(second.id);
	expect(await readFile(path('archive', first.id), 'utf8')).toBe(first.body);
	expect(await readFile(path('archive', second.id), 'utf8')).toBe(second.body);
});

test('a conflicting duplicate preserves both bodies and names its conflict', async () => {
	const { id, body } = await collision();
	const pending = await readFile(path('inbox', id), 'utf8');
	expect(await acknowledgeMessage('beta', id).catch((error: unknown) => error)).toBeInstanceOf(
		MailArchiveConflictError,
	);
	expect(await readFile(path('archive', id), 'utf8')).toBe(body);
	expect(await readFile(path('inbox', id), 'utf8')).toBe(pending);
});

test('identical redelivery ignores only Sent and preserves the first archive bytes', async () => {
	const { id, body } = await sent();
	await acknowledgeMessage('beta', id);
	const redelivered = body.replace(/^Sent: .*$/m, 'Sent: 2030-01-01T00:00:00.000Z');
	await writeFile(path('inbox', id), redelivered, { flag: 'wx' });
	await acknowledgeMessage('beta', id);
	expect(await readFile(path('archive', id), 'utf8')).toBe(body);
	expect(await readdir(join(fixture.records, 'mailboxes', 'beta', 'inbox'))).toEqual([]);
});

test('a Sent-looking body line is content, not the generated timestamp', async () => {
	const { id, body } = await sent('Sent: first body line');
	await acknowledgeMessage('beta', id);
	await conflictingCopy(id, 'Sent: first body line', 'Sent: changed body line');
	expect(await acknowledgeMessage('beta', id).catch((error: unknown) => error)).toBeInstanceOf(
		MailArchiveConflictError,
	);
	expect(await readFile(path('archive', id), 'utf8')).toBe(body);
	expect(await readFile(path('inbox', id), 'utf8')).toContain('Sent: changed body line');
});

test('a crash after linking converges without replacing the linked archive', async () => {
	const { id, body } = await sent();
	await mkdir(join(fixture.records, 'mailboxes', 'beta', 'archive'));
	await link(path('inbox', id), path('archive', id));
	await acknowledgeMessage('beta', id);
	expect(await readFile(path('archive', id), 'utf8')).toBe(body);
	expect(await readdir(join(fixture.records, 'mailboxes', 'beta', 'inbox'))).toEqual([]);
});

test('a message absent from both folders still fails', async () => {
	expect(
		await acknowledgeMessage('beta', randomUUID()).catch((error: unknown) => error),
	).toMatchObject({
		code: 'ENOENT',
	});
});

test('repeated hold confirmations converge while retaining the first archived notice', async () => {
	const { id } = await sent();
	await recordRead('beta', { id, kind: 'request', from: 'alpha' });
	await confirmMessage('beta', id, 'Assessed; needs approval.');
	const first = await holdMessage('beta', id, 'Needs approval', 'Change only this setting');
	const notice = path('inbox', first.hold.id, 'alpha');
	// Force a timestamp difference, without relying on clock resolution.
	const body = (await readFile(notice, 'utf8')).replace(
		/^Sent: .*$/m,
		'Sent: 2020-01-01T00:00:00.000Z',
	);
	await writeFile(notice, body);
	await acknowledgeMessage('alpha', first.hold.id);
	const second = await holdMessage('beta', id, 'Needs approval', 'Change only this setting');
	expect(second.hold.id).toBe(first.hold.id);
	await acknowledgeMessage('alpha', second.hold.id);
	expect(await readFile(path('archive', first.hold.id, 'alpha'), 'utf8')).toBe(body);
});

for (const scoped of [false, true]) {
	test(`${scoped ? 'ack-self' : 'operator ack'} reports a conflict without archive replacement`, async () => {
		const { id, body } = await collision();
		const args = scoped ? ['--mail', 'ack-self', id] : ['--mail', 'ack', 'beta', id];
		const result = await fixture.run(args, scoped ? 'beta' : '');
		expect(result.code).toBe(1);
		expect(result.error).toContain('Mail archive identity conflict');
		expect(await readFile(path('archive', id), 'utf8')).toBe(body);
		expect(await readFile(path('inbox', id), 'utf8')).toContain('Different body');
	});
}

test('60-cycle reused-ID control never replaces an archive', async () => {
	const outcomes = { conflicts: 0, ioErrors: 0, replacements: 0 };
	for (let index = 0; index < 60; index += 1) {
		const { id, body } = await collision();
		try {
			await acknowledgeMessage('beta', id);
		} catch (error: unknown) {
			if (error instanceof MailArchiveConflictError) outcomes.conflicts += 1;
			else if (errorCode(error) === 'EPERM') outcomes.ioErrors += 1;
			else throw error;
		}
		if ((await readFile(path('archive', id), 'utf8')) !== body) outcomes.replacements += 1;
		expect(await readFile(path('inbox', id), 'utf8')).toContain('Different body');
	}
	console.log('Archive collision control:', JSON.stringify(outcomes));
	expect(outcomes.replacements).toBe(0);
	expect(outcomes.conflicts + outcomes.ioErrors).toBe(60);
}, 120000);
