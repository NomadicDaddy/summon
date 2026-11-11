import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { initializeActivity } from '../src/agent-activity.ts';
import { LockBusyError } from '../src/mail-files.ts';
import { statePath } from '../src/mail-read.ts';
import { sendMessage } from '../src/mailbox.ts';
import { restEvidence } from '../src/rest-evidence.ts';
import { readRest, refreshRest, restCommand } from '../src/rest.ts';
import { loadAgent, providers, saveAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const saved = { ...process.env };
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'test-launch';
	await initializeActivity('alpha', 'test-launch');
});
afterEach(async () => {
	process.env = { ...saved };
	await fixture.dispose();
});

async function readMessage(): Promise<string> {
	const id = await sendMessage('alpha', 'alpha', 'Already read fixture request.', {
		id: '00000000-0000-4000-8000-000000000001',
	});
	const marker = statePath('alpha', id, 'read');
	await mkdir(join(marker, '..'), { recursive: true });
	await writeFile(marker, new Date().toISOString());
	return id;
}

test.each(providers)(
	'%s: covered header I/O cannot starve explicit confirmation',
	async (provider) => {
		const record = await loadAgent('alpha');
		if (!record) throw new Error('Missing fixture member');
		record.provider = provider;
		await saveAgent('alpha', record);
		await restCommand(['ready']);
		const id = await readMessage();
		const inbox = join(fixture.records, 'mailboxes/alpha/inbox', `${id}.md`);
		const lock = join(fixture.records, 'runtime/alpha/rest.json.lock');
		let releaseHeader = () => {};
		const headerGate = new Promise<void>((resolve) => {
			releaseHeader = resolve;
		});
		let acquired = () => {};
		const acquiredGate = new Promise<void>((resolve) => {
			acquired = resolve;
		});
		const realOpen = fs.open;
		const realLink = fs.link;
		const open = spyOn(fs, 'open').mockImplementation(async (...args) => {
			if (String(args[0]) === inbox) await headerGate;
			return realOpen(...args);
		});
		const link = spyOn(fs, 'link').mockImplementation(async (...args) => {
			await realLink(...args);
			if (String(args[1]) === lock) acquired();
		});
		let refresh: Promise<Awaited<ReturnType<typeof refreshRest>>> | undefined;
		try {
			refresh = refreshRest('alpha');
			await acquiredGate;
			const result = await restCommand(['ready']).then(
				() => 'confirmed',
				(error: unknown) => {
					if (error instanceof LockBusyError) return 'lock-busy';
					throw error;
				},
			);
			expect(result).toBe('confirmed');
			expect((await readRest('alpha'))?.mode).toBe('ready');
		} finally {
			releaseHeader();
			try {
				await refresh;
			} finally {
				open.mockRestore();
				link.mockRestore();
			}
		}
	},
	15000,
);

test('an unread request after covered mail still blocks rest', async () => {
	await readMessage();
	await sendMessage('alpha', 'alpha', 'New work is unread.', {
		id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
	});
	const refusal = await restCommand(['ready']).catch((error: unknown) => error);
	expect(refusal).toBeInstanceOf(Error);
	expect(refusal).toHaveProperty(
		'message',
		expect.stringContaining('Unread mail needs attention'),
	);
	expect(await readRest('alpha')).toBeUndefined();
});

test('an empty read marker grants no read coverage', async () => {
	const id = await readMessage();
	await writeFile(statePath('alpha', id, 'read'), '');
	expect((await restEvidence('alpha')).reason).toBe('Unread mail needs attention');
});

test('a slow polling evidence read does not hold the rest confirmation lock', async () => {
	await restCommand(['ready']);
	const id = await readMessage();
	const marker = statePath('alpha', id, 'read');
	let releaseRead = () => {};
	const readGate = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	let reading = () => {};
	const readingGate = new Promise<void>((resolve) => {
		reading = resolve;
	});
	let delayed = false;
	const originalRead = fs.readFile;
	const read = spyOn(fs, 'readFile').mockImplementation(
		new Proxy(originalRead, {
			async apply(target, receiver: unknown, args: unknown[]) {
				if (!delayed && String(args[0]) === marker) {
					delayed = true;
					reading();
					await readGate;
				}
				const result: unknown = Reflect.apply(target, receiver, args);
				return await result;
			},
		}),
	);
	let refresh: Promise<Awaited<ReturnType<typeof refreshRest>>> | undefined;
	try {
		refresh = refreshRest('alpha');
		await readingGate;
		await restCommand(['ready']);
		expect((await readRest('alpha'))?.mode).toBe('ready');
		await restCommand(['cancel']);
	} finally {
		releaseRead();
		try {
			await refresh;
		} finally {
			read.mockRestore();
		}
	}
	expect((await readRest('alpha'))?.mode).toBe('awake');
}, 15000);

test('many covered messages do not starve a concurrent rest confirmation', async () => {
	await restCommand(['ready']);
	const inbox = join(fixture.records, 'mailboxes/alpha/inbox');
	await mkdir(inbox, { recursive: true });
	await mkdir(dirname(statePath('alpha', randomUUID(), 'read')), { recursive: true });
	await Promise.all(
		Array.from({ length: 160 }, async () => {
			const id = randomUUID();
			await writeFile(join(inbox, `${id}.md`), 'covered');
			await writeFile(statePath('alpha', id, 'read'), 'read');
		}),
	);
	const lock = join(fixture.records, 'runtime/alpha/rest.json.lock');
	const realRead = fs.readFile;
	const realLink = fs.link;
	const read = spyOn(fs, 'readFile').mockImplementation(
		new Proxy(realRead, {
			async apply(target, receiver: unknown, args: unknown[]) {
				if (
					String(args[0]).startsWith(fixture.records) &&
					String(args[0]).endsWith('.read')
				)
					await delay(40);
				const result: unknown = Reflect.apply(target, receiver, args);
				return await result;
			},
		}),
	);
	let acquired = () => {};
	const acquiredGate = new Promise<void>((resolve) => {
		acquired = resolve;
	});
	const link = spyOn(fs, 'link').mockImplementation(async (...args) => {
		await realLink(...args);
		if (String(args[1]) === lock) acquired();
	});
	let refresh: Promise<Awaited<ReturnType<typeof refreshRest>>> | undefined;
	try {
		refresh = refreshRest('alpha');
		await acquiredGate;
		await restCommand(['ready']);
		expect((await readRest('alpha'))?.mode).toBe('ready');
	} finally {
		try {
			await refresh;
		} finally {
			read.mockRestore();
			link.mockRestore();
		}
	}
}, 15000);

test('unread malformed headers still fail closed', async () => {
	const id = await readMessage();
	await fs.unlink(statePath('alpha', id, 'read'));
	await writeFile(join(fixture.records, 'mailboxes/alpha/inbox', `${id}.md`), 'broken');
	const malformed = await restEvidence('alpha').catch((error: unknown) => error);
	expect(malformed).toBeInstanceOf(Error);
	expect(malformed).toHaveProperty(
		'message',
		expect.stringContaining('Malformed message header'),
	);
});
