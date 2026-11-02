import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';

import type { Hold } from '../src/mail-attention.ts';

import { migrateCheckpointState } from '../src/checkpoint-migration-model.ts';
import { checkpointHash } from '../src/checkpoint-package-model.ts';

test('settled empty migration retains receipts and only previously seen unchanged decisions', () => {
	const hold: Hold = {
		id: randomUUID(),
		agent: 'alpha',
		messageId: randomUUID(),
		sender: 'beta',
		reason: 'Boundary',
		proposal: 'Wait',
		digest: 'original',
		createdAt: new Date().toISOString(),
		decision: 'pending',
		userReference: '',
	};
	const lastAck = randomUUID();
	const empty = randomUUID();
	const before = {
		seen: [createHash('sha256').update(JSON.stringify(hold)).digest('hex')],
		lastAck,
		mailNext: null,
		holdNext: null,
		pending: {
			token: empty,
			room: 42,
			telegram: 11,
			seen: [],
			mailNext: null,
			holdNext: null,
			readMail: [],
			output: { paused: false, receipt: empty, changed: false, more: false },
		},
	};
	const converted = migrateCheckpointState(JSON.stringify(before), 42, 11, [hold]);
	expect(converted).toEqual({
		version: 2,
		seenHolds: { [hold.id]: checkpointHash(hold) },
		lastAck,
		emptyReceipt: empty,
	});
	expect(migrateCheckpointState(JSON.stringify(converted), 42, 11, [hold])).toEqual(converted);
	expect(
		migrateCheckpointState(JSON.stringify(before), 42, 11, [
			{ ...hold, decision: 'approve', userReference: 'actual human' },
		]).seenHolds,
	).toEqual({});
	for (const pending of [
		{ ...before.pending, room: 43 },
		{ ...before.pending, telegram: 12 },
		{ ...before.pending, readMail: [{}] },
		{ ...before.pending, output: { ...before.pending.output, room: { events: ['unread'] } } },
		{ ...before.pending, output: { ...before.pending.output, changed: true } },
		{ ...before.pending, output: { ...before.pending.output, more: true } },
	])
		expect(() =>
			migrateCheckpointState(JSON.stringify({ ...before, pending }), 42, 11, [hold]),
		).toThrow('Unsettled checkpoint batch');
	expect(before.pending.output.changed).toBe(false);
});

test('migration refuses incomplete pagination and unknown corrupt schemas', () => {
	for (const raw of [
		'{',
		'{}',
		JSON.stringify({ seen: [], mailNext: randomUUID(), holdNext: null }),
	])
		expect(() => migrateCheckpointState(raw, 0, undefined, [])).toThrow();
	expect(
		migrateCheckpointState(
			JSON.stringify({ seen: [], mailNext: null, holdNext: null }),
			0,
			undefined,
			[],
		),
	).toEqual({ version: 2, seenHolds: {} });
});

test('terminal empty receipt supersedes the preceding saved pagination pointers', () => {
	const token = randomUUID();
	const lastAck = randomUUID();
	const base = {
		seen: [],
		lastAck,
		mailNext: 'preceding-mail-page',
		holdNext: 'preceding-hold-page',
		pending: {
			token,
			room: 42,
			telegram: 11,
			seen: [],
			mailNext: null,
			holdNext: null,
			readMail: [],
			output: { paused: false, receipt: token, changed: false, more: false },
		},
	};
	const raw = JSON.stringify(base);
	expect(migrateCheckpointState(raw, 42, 11, [])).toEqual({
		version: 2,
		seenHolds: {},
		lastAck,
		emptyReceipt: token,
	});
	expect(JSON.stringify(base)).toBe(raw);
	for (const pending of [
		{ ...base.pending, mailNext: 'unfinished-mail-page' },
		{ ...base.pending, holdNext: 'unfinished-hold-page' },
		{ ...base.pending, readMail: [{}] },
		{ ...base.pending, room: 43 },
		{ ...base.pending, telegram: 12 },
		{ ...base.pending, output: { ...base.pending.output, changed: true } },
		{ ...base.pending, output: { ...base.pending.output, more: true } },
		{ ...base.pending, output: { ...base.pending.output, receipt: randomUUID() } },
		{ ...base.pending, output: { ...base.pending.output, mail: { messages: ['unread'] } } },
	]) {
		expect(() =>
			migrateCheckpointState(JSON.stringify({ ...base, pending }), 42, 11, []),
		).toThrow('Unsettled checkpoint batch');
	}
	const withoutReceipt = {
		seen: base.seen,
		lastAck: base.lastAck,
		mailNext: base.mailNext,
		holdNext: base.holdNext,
	};
	expect(() => migrateCheckpointState(JSON.stringify(withoutReceipt), 42, 11, [])).toThrow(
		'Unsettled checkpoint batch',
	);
});
