import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';

import { MailArchiveConflictError } from '../src/mail-archive.ts';
import { MailIdentityConflictError } from '../src/mail-replay.ts';
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
	mock.restore();
	if (previousHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousHome;
	if (previousAgent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previousAgent;
	await fixture.dispose();
});

const mailbox = () => join(fixture.records, 'mailboxes', 'beta');
const path = (folder: 'inbox' | 'archive', id: string) => join(mailbox(), folder, `${id}.md`);

async function redelivered() {
	const id = randomUUID();
	await sendMessage('alpha', 'beta', 'Original body', { id });
	const body = await fs.readFile(path('inbox', id), 'utf8');
	await acknowledgeMessage('beta', id);
	await fs.writeFile(path('inbox', id), body, { flag: 'wx' });
	return { id, body };
}

async function until(check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error('Fixture synchronization was not observed.');
		await Bun.sleep(10);
	}
}

/** Stop after comparison, at the actual inbox removal; no production test hook. */
function pauseUnlink(id: string, afterRemoval?: () => Promise<void>) {
	const original = fs.unlink;
	const release = Promise.withResolvers<undefined>();
	let entered = false;
	spyOn(fs, 'unlink').mockImplementation(async (target) => {
		if (String(target) !== path('inbox', id) || entered) return original(target);
		entered = true;
		await release.promise;
		await original(target);
		await afterRemoval?.();
	});
	return { release: () => release.resolve(undefined), entered: () => Promise.resolve(entered) };
}

test('overlapping acknowledgements cannot remove a newly published conflicting copy', async () => {
	const { id, body } = await redelivered();
	const pause = pauseUnlink(id, async () => {
		// A send under this ID is refused at the sender now (see the lock tests below), so the
		// conflicting copy arrives the way an older build or a hand-placed file would.
		await fs.writeFile(
			path('inbox', id),
			body.replace('Original body', 'New body after removal'),
			{ flag: 'wx' },
		);
	});
	const first = acknowledgeMessage('beta', id);
	let second: Promise<void> | undefined;
	try {
		await until(pause.entered);
		second = acknowledgeMessage('beta', id);
		// Both acknowledgement lock candidates exist, but only the first owns the lock.
		await until(
			async () =>
				(await fs.readdir(join(mailbox(), 'acks'))).filter(
					(name) => name.startsWith(`${id}.lock.`) && name.endsWith('.pending'),
				).length === 2,
		);
		pause.release();
		await first;
		expect(await second.catch((error: unknown) => error)).toBeInstanceOf(
			MailArchiveConflictError,
		);
		expect(await fs.readFile(path('archive', id), 'utf8')).toBe(body);
		expect(await fs.readFile(path('inbox', id), 'utf8')).toContain('New body after removal');
	} finally {
		pause.release();
		await Promise.allSettled([first, ...(second ? [second] : [])]);
	}
}, 20000);

for (const scoped of [false, true]) {
	test(`${scoped ? 'ack-self' : 'operator ack'} shares the direct acknowledgement lock`, async () => {
		const { id, body } = await redelivered();
		const pause = pauseUnlink(id);
		const first = acknowledgeMessage('beta', id);
		let second: ReturnType<typeof fixture.run> | undefined;
		try {
			await until(pause.entered);
			const args = scoped ? ['--mail', 'ack-self', id] : ['--mail', 'ack', 'beta', id];
			second = fixture.run(args, scoped ? 'beta' : '');
			await until(
				async () =>
					(await fs.readdir(join(mailbox(), 'acks'))).filter(
						(name) => name.startsWith(`${id}.lock.`) && name.endsWith('.pending'),
					).length === 2,
			);
			// A conflicting resend under this ID queues on the same lock instead of publishing
			// between the acknowledgement's comparison and its removal of the inbox copy.
			const resend = sendMessage('alpha', 'beta', 'Pending resend', { id }).catch(
				(error: unknown) => error,
			);
			await until(
				async () =>
					(await fs.readdir(join(mailbox(), 'acks'))).filter(
						(name) => name.startsWith(`${id}.lock.`) && name.endsWith('.pending'),
					).length === 3,
			);
			expect(await fs.readFile(path('inbox', id), 'utf8')).toBe(body);
			pause.release();
			await first;
			expect((await second).code).toBe(0);
			// It then finds the archived copy and is refused, so nothing reaches the inbox again.
			expect(await resend).toBeInstanceOf(MailIdentityConflictError);
			expect(await fs.readFile(path('archive', id), 'utf8')).toBe(body);
			expect(await fs.readdir(join(mailbox(), 'inbox'))).toEqual([]);
		} finally {
			pause.release();
			await Promise.allSettled([first, ...(second ? [second] : [])]);
		}
	}, 20000);
}

test('archive publication I/O errors surface without removing the inbox', async () => {
	const id = await sendMessage('alpha', 'beta', 'Keep this pending');
	const body = await fs.readFile(path('inbox', id), 'utf8');
	const original = fs.link;
	spyOn(fs, 'link').mockImplementation(async (from, to) => {
		if (String(to) === path('archive', id))
			throw Object.assign(new Error('Injected archive access refusal'), { code: 'EPERM' });
		await original(from, to);
	});
	expect(await acknowledgeMessage('beta', id).catch((error: unknown) => error)).toMatchObject({
		code: 'EPERM',
	});
	expect(await fs.readFile(path('inbox', id), 'utf8')).toBe(body);
	expect(await fs.readdir(join(mailbox(), 'archive'))).toEqual([]);
});

test('an inbox unlink failure preserves both names and the next ack converges', async () => {
	const id = await sendMessage('alpha', 'beta', 'Preserve after unlink error');
	const body = await fs.readFile(path('inbox', id), 'utf8');
	const original = fs.unlink;
	const fault = spyOn(fs, 'unlink').mockImplementation(async (target) => {
		if (String(target) === path('inbox', id))
			throw Object.assign(new Error('Injected inbox access refusal'), { code: 'EPERM' });
		await original(target);
	});
	expect(await acknowledgeMessage('beta', id).catch((error: unknown) => error)).toMatchObject({
		code: 'EPERM',
	});
	expect(await fs.readFile(path('inbox', id), 'utf8')).toBe(body);
	expect(await fs.readFile(path('archive', id), 'utf8')).toBe(body);
	fault.mockRestore();
	await acknowledgeMessage('beta', id);
	expect(await fs.readFile(path('archive', id), 'utf8')).toBe(body);
	expect(await fs.readdir(join(mailbox(), 'inbox'))).toEqual([]);
});

test('repeated ack also converges when link reports EEXIST before its missing source', async () => {
	const id = await sendMessage('alpha', 'beta', 'Already archived');
	await acknowledgeMessage('beta', id);
	const body = await fs.readFile(path('archive', id), 'utf8');
	const original = fs.link;
	spyOn(fs, 'link').mockImplementation(async (from, to) => {
		if (String(to) === path('archive', id))
			throw Object.assign(new Error('Existing archive first'), { code: 'EEXIST' });
		await original(from, to);
	});
	await acknowledgeMessage('beta', id);
	expect(await fs.readFile(path('archive', id), 'utf8')).toBe(body);
});
