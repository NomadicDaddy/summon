import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { addBoardComment, createBoardItem } from '../src/board.ts';
import { communicationSend } from '../src/communication-gate.ts';
import { communicationState, setCommunicationPause } from '../src/communication-state.ts';
import { addDiary } from '../src/diary.ts';
import { sendCliMessage } from '../src/local-room-access.ts';
import { sendMessage } from '../src/mailbox.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const original = process.env.SUMMON_HOME;
const config = { botToken: '123:fixture', chatId: '456', allowedUserIds: ['456'] };
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await mkdir(join(fixture.records, 'integrations'));
	await writeFile(join(fixture.records, 'integrations/telegram.json'), JSON.stringify(config));
});
afterEach(async () => {
	if (original === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = original;
	await fixture.dispose();
});

test('network outage warns safely and permits local work without changing halt state', async () => {
	const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(
		Object.assign(new Error('PRIVATE_CANARY_URL'), { code: 'ENOTFOUND' }),
	);
	let started = false;
	const warning = spyOn(console, 'warn').mockImplementation(() => {});
	try {
		await communicationSend('send the Room post', () => {
			started = true;
			return Promise.resolve();
		});
		expect(started).toBe(true);
		expect(warning.mock.calls.flat().join(' ')).toContain('Telegram DNS lookup failed');
		// In Proceed, the warning names the recorded state without asserting a halt (#22292).
		expect(warning.mock.calls.flat().join(' ')).toContain(
			'Local work uses the recorded communication state',
		);
		expect(warning.mock.calls.flat().join(' ')).not.toContain('halt state');
		expect(warning.mock.calls.flat().join(' ')).not.toContain('PRIVATE_CANARY');
		await setCommunicationPause(true);
		const halted = await communicationState();
		started = false;
		const refusal = await communicationSend('send the Room post', () => {
			started = true;
			return Promise.resolve();
		}).catch((error: unknown) => String(error));
		expect(refusal).toContain('Halt:');
		expect(started).toBe(false);
		expect(await communicationState()).toEqual(halted);
	} finally {
		fetch.mockRestore();
		warning.mockRestore();
	}
});

test('HTTP outage permits actual Board, Diary, Room and mail writes', async () => {
	const fetch = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(
			() =>
				Promise.resolve(
					Response.json({ ok: false, description: 'PRIVATE_CANARY' }, { status: 429 }),
				),
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	const warning = spyOn(console, 'warn').mockImplementation(() => {});
	try {
		const card = (await createBoardItem({ title: 'Fixture' })).items[0];
		if (!card) throw new Error('Expected saved card');
		expect(card.title).toBe('Fixture');
		await addBoardComment(card.id, 'Fixture');
		await addDiary({ for: 'Fixture', task: 'Fixture', room: [], board: [] });
		expect((await sendCliMessage('Fixture')).text).toBe('Fixture');
		const id = await sendMessage('alpha', 'beta', 'Fixture');
		expect(id).toBeTruthy();
		expect(warning.mock.calls).toHaveLength(5);
		expect(warning.mock.calls.flat().join(' ')).toContain('HTTP 429');
		expect(warning.mock.calls.flat().join(' ')).not.toContain('PRIVATE_CANARY');
	} finally {
		fetch.mockRestore();
		warning.mockRestore();
	}
});

test('a hanging Telegram poll bounds local sends before using recorded state', async () => {
	const entered = Promise.withResolvers<boolean>();
	const response = Promise.withResolvers<Response>();
	const fetch = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(
			() => {
				entered.resolve(true);
				return response.promise;
			},
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	const warning = spyOn(console, 'warn').mockImplementation(() => {});
	const sent: string[] = [];
	const send = (value: string) =>
		communicationSend('send the Room post', () => {
			sent.push(value);
			return Promise.resolve(value);
		});
	const holder = send('holder').catch((error: unknown) => String(error));
	try {
		await entered.promise;
		const started = Date.now();
		const writes = Promise.all([send('second'), send('third')]);
		await Bun.sleep(100);
		expect(sent).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(await writes).toEqual(['second', 'third']);
		expect(Date.now() - started).toBeGreaterThan(6_000);
		expect(warning.mock.calls.flat().join(' ')).toContain('beyond the bounded wait');
		expect(fetch).toHaveBeenCalledTimes(1);
	} finally {
		response.reject(Object.assign(new Error('fixture timeout'), { name: 'TimeoutError' }));
		await holder;
		fetch.mockRestore();
		warning.mockRestore();
	}
}, 20_000);

test('a recorded Halt during a hanging poll refuses the holder and waiting send', async () => {
	const entered = Promise.withResolvers<boolean>();
	const response = Promise.withResolvers<Response>();
	const fetch = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(
			() => {
				entered.resolve(true);
				return response.promise;
			},
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	const warning = spyOn(console, 'warn').mockImplementation(() => {});
	const sent: string[] = [];
	const send = (value: string) =>
		communicationSend('send the Room post', () => {
			sent.push(value);
			return Promise.resolve(value);
		}).catch((error: unknown) => String(error));
	const holder = send('holder');
	let waiting: Promise<string> | undefined;
	try {
		await entered.promise;
		waiting = send('waiting');
		await Bun.sleep(100);
		expect(sent).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(1);
		await setCommunicationPause(true);
		response.reject(Object.assign(new Error('fixture timeout'), { name: 'TimeoutError' }));
		expect(await holder).toContain('Halt:');
		expect(await waiting).toContain('Halt:');
		expect(sent).toEqual([]);
	} finally {
		response.reject(Object.assign(new Error('fixture timeout'), { name: 'TimeoutError' }));
		if (waiting) await waiting;
		await holder;
		fetch.mockRestore();
		warning.mockRestore();
	}
}, 20_000);

test('successful refresh still permits the operation and malformed configuration names its refusal', async () => {
	const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
		Response.json({ ok: true, result: [] }),
	);
	try {
		expect(
			await communicationSend('save the Diary entry', () => Promise.resolve('saved')),
		).toBe('saved');
		await writeFile(join(fixture.records, 'integrations/telegram.json'), '{PRIVATE_CANARY');
		const result = await communicationSend('save the Diary entry', () =>
			Promise.resolve('must not run'),
		).catch((error: unknown) => String(error));
		expect(result).toContain('did not save the Diary entry');
		expect(result).toContain('Invalid Telegram configuration JSON');
		expect(result).not.toContain('PRIVATE_CANARY');
	} finally {
		fetch.mockRestore();
	}
});
