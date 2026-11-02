import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TeamEvent } from '../src/desktop/types.ts';

import { initializeActivity } from '../src/agent-activity.ts';
import { faultText } from '../src/desktop/fault-report.ts';
import { runtimeFaultDelivery } from '../src/desktop/runtime-fault-delivery.ts';
import { runtimeFaultInput, runtimeFaultText } from '../src/runtime-fault-model.ts';
import {
	appendRuntimeFault,
	FAULT_ARCHIVES,
	FAULT_SEGMENT_BYTES,
	readRuntimeFaults,
} from '../src/runtime-faults.ts';
import { newRecord, saveAgent } from '../src/store.ts';
import {
	runtimeFaultFixture as fixture,
	runtimeFaultRejection as rejection,
} from './fixtures/runtime-fault-test.ts';

const started = '2026-10-06T20:00:00.000Z';
const input = { level: 'error', source: 'room.send', text: 'Message not confirmed.' } as const;

test('durable reports preserve attribution; repeated faults collapse only in the reader', async () =>
	fixture(async (root) => {
		await appendRuntimeFault({ ...input, member: 'alice' }, started);
		await appendRuntimeFault({ ...input, member: 'alice' }, started);
		await appendRuntimeFault({ ...input, member: 'jimmy' }, started);
		await appendRuntimeFault({ ...input, level: 'warning', member: 'alice' }, started);
		const result = await readRuntimeFaults({ limit: 50 });
		expect(result.retainedOccurrences).toBe(4);
		expect(result.entries).toHaveLength(3);
		expect(
			result.entries.find((entry) => entry.member === 'alice' && entry.level === 'error'),
		).toMatchObject({ count: 2, source: 'room.send', windowStartedAt: started });
		const raw = await readFile(join(root, 'logs/runtime-faults/current.jsonl'), 'utf8');
		expect(raw.trim().split('\n')).toHaveLength(4);
		expect(
			new Set(
				raw
					.trim()
					.split('\n')
					.map((line) => (JSON.parse(line) as { id: string }).id),
			).size,
		).toBe(4);
	}));

test('diagnostic reasons omit structured payloads, stacks, quoted bodies and credential-shaped details', () => {
	const sentinels = ['TEST_AUTH_SENTINEL', 'TEST_QUOTED_BODY', 'TEST_STACK_SENTINEL'];
	const text = runtimeFaultText(
		`Error invoking remote method 'team:room-send': Error: EACCES token=${sentinels[0]} "${sentinels[1]}"\n${sentinels[2]}`,
	);
	for (const sentinel of sentinels) expect(text).not.toContain(sentinel);
	for (const raw of [
		'[{"message":"TEST_PRIVATE_INPUT"}]',
		'JSON Parse error: TEST_PRIVATE_INPUT',
	])
		expect(runtimeFaultText(raw)).toBe('Invalid structured input; payload details omitted.');
	const url = runtimeFaultText(
		'Connection failed https://example.invalid/TEST_PATH?value=TEST_QUERY',
	);
	expect(url).toBe('Connection failed [URL omitted]');
	expect(
		runtimeFaultText('account/read failed: workspace routing discovery failed (code -32603)'),
	).toContain('workspace routing discovery failed');
	const frontEnd = faultText(new Error('Permission denied.\nTEST_PRIVATE_STACK'));
	const normalized = runtimeFaultText(frontEnd);
	expect(frontEnd).toContain('\n');
	expect(normalized).toBe('Permission denied.');
	expect(runtimeFaultText('Cookie: first=TEST_HEADER_ONE; second=TEST_HEADER_TWO')).toBe(
		'[credential header omitted]',
	);
});

test('failed persistence keeps the original visible, never recurses, and resumes after recovery', async () => {
	const sent: TeamEvent[] = [];
	let fail = true;
	let writes = 0;
	const delivery = runtimeFaultDelivery(
		() => started,
		(event) => sent.push(event),
		(value) => {
			writes++;
			if (fail) return Promise.reject(new Error('TEST_STORAGE_FAILURE'));
			return Promise.resolve({
				...runtimeFaultInput.parse(value),
				id: randomUUID(),
				at: started,
				windowStartedAt: started,
			});
		},
	);
	delivery.send({ type: 'output', slug: 'alice', data: 'TEST_PRIVATE_TERMINAL' });
	delivery.send({ type: 'error', message: 'Original first failure.', slug: 'alice' });
	delivery.send({ type: 'error', message: 'Original second failure.', slug: 'jimmy' });
	await delivery.flush();
	await Promise.resolve();
	expect(writes).toBe(2);
	expect(
		sent.filter((event) => event.type === 'error' && event.message.includes('log unavailable')),
	).toHaveLength(1);
	expect(sent).toContainEqual({
		type: 'error',
		message: 'Original first failure.',
		slug: 'alice',
		diagnosticHandled: true,
		diagnosticSaved: false,
	});
	expect(sent).toContainEqual({
		type: 'error',
		message: 'Original second failure.',
		slug: 'jimmy',
		diagnosticHandled: true,
		diagnosticSaved: false,
	});
	fail = false;
	await delivery.report(input);
	fail = true;
	expect((await rejection(delivery.report(input))).message).toContain('TEST_STORAGE_FAILURE');
	await delivery.flush();
	expect(writes).toBe(4);
	expect(
		sent.filter((event) => event.type === 'error' && event.message.includes('log unavailable')),
	).toHaveLength(2);
});

test('invalid reports and damaged journals refuse writes without erasing surviving evidence', async () =>
	fixture(async (root) => {
		expect(
			await rejection(appendRuntimeFault({ ...input, source: '../private' }, started)),
		).toBeInstanceOf(Error);
		expect(
			await rejection(
				appendRuntimeFault({ ...input, prompt: 'TEST_PRIVATE_INPUT' }, started),
			),
		).toBeInstanceOf(Error);
		expect(await readdir(root)).toHaveLength(0);
		await appendRuntimeFault(input, started);
		const path = join(root, 'logs/runtime-faults/current.jsonl');
		const broken = `${await readFile(path, 'utf8')}{partial`;
		await writeFile(path, broken);
		expect((await rejection(appendRuntimeFault(input, started))).message).toContain('damaged');
		expect(await readFile(path, 'utf8')).toBe(broken);
		expect((await rejection(readRuntimeFaults({ limit: 50 }))).message).toContain('damaged');
	}));

test('fixed rotation preserves retained journal bytes and unrelated files', async () =>
	fixture(async (root) => {
		await appendRuntimeFault(input, started);
		const logRoot = join(root, 'logs/runtime-faults');
		const large = `${JSON.stringify({ ...input, text: 'x'.repeat(2048), id: randomUUID(), at: started, windowStartedAt: started })}\n`;
		const raw = large.repeat(Math.floor(FAULT_SEGMENT_BYTES / Buffer.byteLength(large)));
		await writeFile(join(logRoot, 'current.jsonl'), raw);
		for (let index = 0; index < 5; index++)
			await writeFile(join(logRoot, `2026010100000000${index}-${randomUUID()}.jsonl`), large);
		await writeFile(join(logRoot, 'unrelated.txt'), 'preserve');
		await appendRuntimeFault({ ...input, text: 'y'.repeat(2048) }, started);
		const names = (await readdir(logRoot)).filter(
			(name) => name !== 'current.jsonl' && name.endsWith('.jsonl'),
		);
		expect(names).toHaveLength(FAULT_ARCHIVES);
		expect(await readFile(join(logRoot, names.sort().at(-1) ?? ''), 'utf8')).toBe(raw);
		expect(await readFile(join(logRoot, 'unrelated.txt'), 'utf8')).toBe('preserve');
		expect((await readRuntimeFaults({ limit: 200 })).maximumBytes).toBe(
			4 * FAULT_SEGMENT_BYTES,
		);
	}));

test('all four named provider CLIs can read public diagnostics without writing or exposing terminal data', async () =>
	fixture(async (root) => {
		await appendRuntimeFault({ ...input, member: 'alice' }, started);
		for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const) {
			const name = `fault-${provider}`;
			await saveAgent(name, newRecord(name, root, provider));
			await initializeActivity(name, `fixture-${provider}`);
			const before = (await readdir(root, { recursive: true })).sort();
			const journal = await readFile(join(root, 'logs/runtime-faults/current.jsonl'), 'utf8');
			const child = Bun.spawn(
				[process.execPath, 'src/cli.ts', '--faults', '--member', 'alice'],
				{
					env: {
						...process.env,
						SUMMON_HOME: root,
						SUMMON_AGENT: name,
						SUMMON_NONCE: `fixture-${provider}`,
					},
					stdout: 'pipe',
					stderr: 'pipe',
				},
			);
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(code).toBe(0);
			expect(stderr).toBe('');
			expect(JSON.parse(stdout)).toMatchObject({
				retainedOccurrences: 1,
				entries: [{ member: 'alice' }],
			});
			expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
			expect(await readFile(join(root, 'logs/runtime-faults/current.jsonl'), 'utf8')).toBe(
				journal,
			);
		}
	}));

test('named callers cannot append and redirected log directories are refused', async () =>
	fixture(async (root) => {
		const previous = process.env.SUMMON_AGENT;
		process.env.SUMMON_AGENT = 'fixture-agent';
		try {
			expect((await rejection(appendRuntimeFault(input, started))).message).toContain(
				'human operator only',
			);
		} finally {
			if (previous === undefined) delete process.env.SUMMON_AGENT;
			else process.env.SUMMON_AGENT = previous;
		}
		expect(await readdir(root)).toHaveLength(0);
		const target = join(root, 'redirect-target');
		await mkdir(target);
		await writeFile(join(target, 'positive-control.txt'), 'preserve');
		await symlink(
			target,
			join(root, 'logs'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		expect((await rejection(appendRuntimeFault(input, started))).message).toContain(
			'redirected',
		);
		expect((await rejection(readRuntimeFaults({ limit: 50 }))).message).toContain('redirected');
		expect(await readdir(target)).toEqual(['positive-control.txt']);
		expect(await readFile(join(target, 'positive-control.txt'), 'utf8')).toBe('preserve');
	}));

test('separate processes append without losing or corrupting concurrent diagnostics', async () =>
	fixture(async (root) => {
		const children = [0, 1, 2, 3].map((index) =>
			Bun.spawn(
				[process.execPath, 'test/fixtures/runtime-fault-writer.ts', root, String(index)],
				{
					env: { ...process.env, SUMMON_HOME: root },
					stdout: 'pipe',
					stderr: 'pipe',
				},
			),
		);
		for (const child of children) {
			const [code, stderr] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
			]);
			expect(stderr).toBe('');
			expect(code).toBe(0);
		}
		const result = await readRuntimeFaults({ limit: 50 });
		expect(result.retainedOccurrences).toBe(20);
		expect(result.entries).toHaveLength(20);
		expect(new Set(result.entries.map((entry) => entry.id)).size).toBe(20);
	}));
