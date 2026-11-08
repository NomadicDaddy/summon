import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CommunicationsPausedError, setCommunicationPause } from '../src/communication-state.ts';
import { confirmMessage, recordRead, statePath } from '../src/mail-read.ts';
import { sentStatus } from '../src/mail-sent-status.ts';
import { sendMessage } from '../src/mailbox.ts';
import { newRecord } from '../src/store.ts';
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

const folder = (name: string, kind: 'inbox' | 'archive') =>
	join(fixture.records, 'mailboxes', name, kind);
const files = async (name: string, kind: 'inbox' | 'archive') =>
	(await readdir(folder(name, kind)).catch(() => [] as string[])).filter((file) =>
		file.endsWith('.md'),
	);
const body = (name: string, kind: 'inbox' | 'archive', id: string) =>
	readFile(join(folder(name, kind), `${id}.md`), 'utf8');
async function refusal(work: Promise<unknown>): Promise<string> {
	return work.then(
		() => '',
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
}

async function asFixtureAgent<T>(name: string, work: () => Promise<T>): Promise<T> {
	const previousAgent = process.env.SUMMON_AGENT;
	const previousNonce = process.env.SUMMON_NONCE;
	process.env.SUMMON_AGENT = name;
	process.env.SUMMON_NONCE = 'test-launch';
	try {
		return await work();
	} finally {
		if (previousAgent === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = previousAgent;
		if (previousNonce === undefined) delete process.env.SUMMON_NONCE;
		else process.env.SUMMON_NONCE = previousNonce;
	}
}

test('a pending fixed ID: identical content is already delivered, differing content is refused', async () => {
	const id = randomUUID();
	expect(await sendMessage('beta', 'alpha', 'First body.', { id })).toBe(id);
	expect(await sendMessage('beta', 'alpha', 'First body.', { id })).toBe(id);
	expect(await files('alpha', 'inbox')).toEqual([`${id}.md`]);
	expect(await refusal(sendMessage('beta', 'alpha', 'Second body.', { id }))).toBe(
		'Mail publication identity conflicts with retained content.',
	);
	expect(await body('alpha', 'inbox', id)).toContain('First body.');
});

test('an archived fixed ID is never delivered again, and differing content is refused', async () => {
	const id = randomUUID();
	await sendMessage('beta', 'alpha', 'Handled body.', { id });
	expect((await fixture.run(['--mail', 'ack-self', id], 'alpha')).code).toBe(0);
	const archived = await body('alpha', 'archive', id);
	expect(await sendMessage('beta', 'alpha', 'Handled body.', { id })).toBe(id);
	expect(await files('alpha', 'inbox')).toEqual([]);
	expect(await refusal(sendMessage('beta', 'alpha', 'Other body.', { id }))).toBe(
		'Mail publication identity conflicts with retained content.',
	);
	expect(await files('alpha', 'inbox')).toEqual([]);
	expect(await body('alpha', 'archive', id)).toBe(archived);
});

test('concurrent sends under one fixed ID converge when equal and refuse when they differ', async () => {
	const equal = randomUUID();
	const sent = await Promise.all(
		Array.from({ length: 8 }, () => sendMessage('beta', 'alpha', 'Same.', { id: equal })),
	);
	expect(sent).toEqual(Array.from({ length: 8 }, () => equal));
	const differ = randomUUID();
	const outcomes = await Promise.allSettled(
		['One.', 'Two.', 'Three.', 'Four.'].map((text) =>
			sendMessage('beta', 'alpha', text, { id: differ }),
		),
	);
	const delivered = outcomes.filter((outcome) => outcome.status === 'fulfilled');
	expect(delivered).toHaveLength(1);
	for (const outcome of outcomes)
		if (outcome.status === 'rejected')
			expect(String(outcome.reason)).toContain('identity conflicts with retained content');
	expect((await files('alpha', 'inbox')).sort()).toEqual([`${differ}.md`, `${equal}.md`].sort());
	expect(
		(await readdir(folder('alpha', 'inbox'))).filter((file) => file.endsWith('.tmp')),
	).toEqual([]);
});

test('random-ID mail is unchanged: identical text twice is two messages', async () => {
	const first = await sendMessage('beta', 'alpha', 'Twice.');
	const second = await sendMessage('beta', 'alpha', 'Twice.');
	expect(first).not.toBe(second);
	expect((await files('alpha', 'inbox')).sort()).toEqual([`${first}.md`, `${second}.md`].sort());
});

test('a reused ID for another recipient cannot erase the first recorded read', async () => {
	await writeFile(
		join(fixture.records, 'gamma.json'),
		JSON.stringify(newRecord('gamma', fixture.root, 'claude')),
	);
	const runtime = join(fixture.records, 'runtime', 'gamma');
	await mkdir(runtime, { recursive: true });
	await writeFile(
		join(runtime, 'activity.json'),
		JSON.stringify({
			state: 'idle',
			workingOn: '',
			nonce: 'test-launch',
			updatedAt: new Date().toISOString(),
		}),
	);
	const shared = randomUUID();
	await asFixtureAgent('gamma', () =>
		sendMessage('gamma', 'alpha', 'Please look.', { id: shared }),
	);
	expect((await fixture.run(['--mail', 'receive'], 'alpha')).code).toBe(0);
	const first = await asFixtureAgent('gamma', () => sentStatus('gamma', shared));
	if (first.status !== 'recorded-read') throw new Error('Expected the first recorded read.');
	expect(
		await refusal(
			asFixtureAgent('gamma', () =>
				sendMessage('gamma', 'beta', 'Please look.', { id: shared }),
			),
		),
	).toBe('Mail ID already belongs to another recipient.');
	expect(await files('beta', 'inbox')).toEqual([]);
	expect(await asFixtureAgent('gamma', () => sentStatus('gamma', shared))).toEqual({
		id: shared,
		status: 'recorded-read',
		readAt: first.readAt,
	});
	const confirmation = await fixture.run(['--mail', 'confirm', shared, 'Looking.'], 'alpha');
	expect(confirmation.code).toBe(0);
	expect((await files('gamma', 'inbox')).length).toBe(1);
});

/** A confirmation delivered by an attempt that then died before writing its confirmed state. */
async function interruptedConfirmation() {
	const id = await sendMessage('alpha', 'beta', 'Please do this.', { kind: 'request' });
	await recordRead('beta', { id, kind: 'request', from: 'alpha' });
	const confirmation = await confirmMessage('beta', id, 'First wording.');
	await rm(statePath('beta', id, 'confirmed'));
	return { id, confirmation };
}

const unconfirmed = async (id: string) =>
	(await readFile(statePath('beta', id, 'confirmed'), 'utf8').catch(() => undefined)) ===
	undefined;

test('an archived confirmation from an interrupted attempt also stands, whatever the wording', async () => {
	const { id, confirmation } = await interruptedConfirmation();
	expect((await fixture.run(['--mail', 'ack-self', confirmation], 'alpha')).code).toBe(0);
	expect(await confirmMessage('beta', id, 'Different wording.')).toBe(confirmation);
	expect(await readFile(statePath('beta', id, 'confirmed'), 'utf8')).toBe(confirmation);
	// The archived confirmation is not delivered again; read status created no receipt mail.
	expect(await files('alpha', 'inbox')).not.toContain(`${confirmation}.md`);
	expect(await body('alpha', 'archive', confirmation)).toContain('First wording.');
});

test('a retained copy with another binding or no header block is refused and marks nothing', async () => {
	for (const replace of [
		(text: string) => text.replace(/^In-Reply-To: .*$/m, `In-Reply-To: ${randomUUID()}`),
		(text: string) => text.replace(/^Kind: confirmation$/m, 'Kind: reply'),
		(text: string) => text.replace(/^From: beta$/m, 'From: gamma'),
		(text: string) => text.replace(/^To: alpha$/m, 'To: gamma'),
		(text: string) => text.replace(/^Kind: /m, 'Extra: header\nKind: '),
		(text: string) => text.replace(/^(Kind: .*)$/m, '$1\n$1'),
		() => 'not a message',
	]) {
		const { id, confirmation } = await interruptedConfirmation();
		const retained = join(folder('alpha', 'inbox'), `${confirmation}.md`);
		await writeFile(retained, replace(await readFile(retained, 'utf8')));
		expect(await refusal(confirmMessage('beta', id, 'Different wording.'))).toBe(
			'Mail publication identity conflicts with retained content.',
		);
		expect(await unconfirmed(id)).toBe(true);
	}
});

test('paused communications refuse the recovery too, and mark nothing', async () => {
	const { id } = await interruptedConfirmation();
	const agent = process.env.SUMMON_AGENT;
	delete process.env.SUMMON_AGENT;
	await setCommunicationPause(true);
	try {
		expect(
			await confirmMessage('beta', id, 'Different wording.').catch((error: unknown) => error),
		).toBeInstanceOf(CommunicationsPausedError);
		expect(await unconfirmed(id)).toBe(true);
	} finally {
		await setCommunicationPause(false);
		if (agent !== undefined) process.env.SUMMON_AGENT = agent;
	}
});

test('a confirmation sent by an attempt that died before recording it stands on retry', async () => {
	const { id, confirmation } = await interruptedConfirmation();
	expect(await confirmMessage('beta', id, 'Different wording.')).toBe(confirmation);
	expect(await readFile(statePath('beta', id, 'confirmed'), 'utf8')).toBe(confirmation);
	expect(await body('alpha', 'inbox', confirmation)).toContain('First wording.');
	const confirmations = [];
	for (const file of await files('alpha', 'inbox'))
		if ((await body('alpha', 'inbox', file.slice(0, -3))).includes('Kind: confirmation'))
			confirmations.push(file);
	expect(confirmations).toEqual([`${confirmation}.md`]);
});
