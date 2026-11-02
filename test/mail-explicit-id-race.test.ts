import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';

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
const exists = (target: string) =>
	fs.stat(target).then(
		() => true,
		() => false,
	);

async function until(check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error('Fixture synchronization was not observed.');
		await Bun.sleep(10);
	}
}

/** Hold publisher A just before its inbox link: after its identity check, inside any lock. */
function pausePublication(id: string) {
	const original = fs.link;
	const release = Promise.withResolvers<undefined>();
	let entered = false;
	spyOn(fs, 'link').mockImplementation(async (source, target) => {
		if (String(target) !== path('inbox', id) || entered) return original(source, target);
		entered = true;
		await release.promise;
		return original(source, target);
	});
	return { release: () => release.resolve(undefined), entered: () => Promise.resolve(entered) };
}

/** A settles last: B and an acknowledgement start while A is held between check and link. */
async function race(secondBody: string) {
	const id = randomUUID();
	const pause = pausePublication(id);
	const first = sendMessage('alpha', 'beta', 'First body', { id });
	await until(pause.entered);
	const settled: string[] = [];
	/** The value on success or the error on failure, and its name in settled either way. */
	const track = async (name: string, work: Promise<unknown>): Promise<unknown> => {
		try {
			return await work;
		} catch (error: unknown) {
			return error;
		} finally {
			settled.push(name);
		}
	};
	const second = track('second', sendMessage('alpha', 'beta', secondBody, { id }));
	const acknowledged = track('ack', acknowledgeMessage('beta', id));
	// Neither may act on the ID while A holds it between its check and its link.
	await Bun.sleep(300);
	expect(settled).toEqual([]);
	expect(await exists(path('inbox', id))).toBe(false);
	expect(await exists(path('archive', id))).toBe(false);
	pause.release();
	expect(await first).toBe(id);
	return { id, second: await second, acknowledged: await acknowledged };
}

test('a differing publication of a held ID is refused, and the archive keeps the first body', async () => {
	const { id, second, acknowledged } = await race('Second body');
	// Checked by message, not class, so this file also runs as a control against the old ordering.
	expect(String(second)).toContain('Mail publication identity conflicts with retained content.');
	expect(acknowledged).toBeUndefined();
	expect(await fs.readFile(path('archive', id), 'utf8')).toContain('First body');
	expect(await exists(path('inbox', id))).toBe(false);
});

test('an identical publication of a held ID is a no-op and is never delivered twice', async () => {
	const { id, second, acknowledged } = await race('First body');
	expect(second).toBe(id);
	expect(acknowledged).toBeUndefined();
	expect(await fs.readFile(path('archive', id), 'utf8')).toContain('First body');
	expect(await exists(path('inbox', id))).toBe(false);
});

test('a random-ID message takes no per-message lock and is delivered as before', async () => {
	const id = await sendMessage('alpha', 'beta', 'Random body');
	expect(await fs.readFile(path('inbox', id), 'utf8')).toContain('Random body');
	expect(await fs.readdir(join(mailbox(), 'acks')).catch(() => [] as string[])).toEqual([]);
});
