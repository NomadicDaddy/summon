import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { collectDiagnostics, type DiagnosticSources } from '../src/diagnostics-collect.ts';
import { newRecord, saveAgent } from '../src/store.ts';
import { runtimeFaultFixture } from './fixtures/runtime-fault-test.ts';

const secret = 'TEST_AUTH_SENTINEL_4a9918';
const peer = 'TEST_PEER_MAIL_BODY_29cb75';

async function run(root: string, args: string[]) {
	const child = Bun.spawn([process.execPath, 'src/cli.ts', '--diagnostics', ...args], {
		env: {
			...process.env,
			SUMMON_HOME: root,
			SUMMON_AGENT: 'morgan',
			SUMMON_NONCE: 'fixture-morgan',
		},
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout, stderr };
}

test('named CLI writes a bounded own-only bundle without peer mail or planted credentials', async () =>
	runtimeFaultFixture(async (root) => {
		const previousAgent = process.env.SUMMON_AGENT;
		const previousNonce = process.env.SUMMON_NONCE;
		delete process.env.SUMMON_AGENT;
		delete process.env.SUMMON_NONCE;
		try {
			await saveAgent('morgan', newRecord('morgan', root, 'codex'));
			await initializeActivity('morgan', 'fixture-morgan');
			const alice = newRecord('alice', root, 'claude');
			alice.expertise = peer;
			await saveAgent('alice', alice);
		} finally {
			if (previousAgent !== undefined) process.env.SUMMON_AGENT = previousAgent;
			if (previousNonce !== undefined) process.env.SUMMON_NONCE = previousNonce;
		}
		const peerMailbox = join(root, 'mailboxes', 'alice');
		await mkdir(peerMailbox, { recursive: true });
		await writeFile(join(peerMailbox, 'private.txt'), peer);
		const journal = join(root, 'logs', 'runtime-faults');
		await mkdir(journal, { recursive: true });
		const current = new Date().toISOString();
		const old = '2020-01-01T00:00:00.000Z';
		const record = (at: string, text: string) =>
			JSON.stringify({
				id: randomUUID(),
				at,
				windowStartedAt: at,
				member: 'morgan',
				level: 'error',
				source: 'diagnostics.test',
				text,
			});
		await writeFile(
			join(journal, 'current.jsonl'),
			`${record(old, 'old fault')}\n${record(current, `token=${secret}`)}\n`,
		);
		const path = join(root, 'support.json');
		const result = await run(root, ['--out', path]);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe('');
		expect(result.stdout).toContain('support.json');
		const raw = await readFile(path, 'utf8');
		expect(raw).not.toContain(secret);
		expect(raw).not.toContain(peer);
		expect(raw).not.toContain('old fault');
		const bundle = JSON.parse(raw) as {
			member: string;
			since: string;
			sections: Record<string, { status: string; value?: { entries?: unknown[] } }>;
			redactions: string[];
		};
		expect(bundle.member).toBe('morgan');
		expect(Date.now() - Date.parse(bundle.since)).toBeGreaterThan(23 * 60 * 60 * 1000);
		expect(bundle.sections.faults?.value?.entries).toHaveLength(1);
		for (const name of [
			'identity',
			'build',
			'prerequisites',
			'providerClis',
			'launchStatus',
			'presence',
			'mailStatus',
			'work',
			'faults',
			'sessionHistory',
		])
			expect(bundle.sections[name]?.status).toMatch(/^(available|unavailable)$/);
		expect(bundle.redactions).toContain('peer mailbox and runtime details');
		const rejected = await run(root, ['--member', 'alice', '--out', join(root, 'peer.json')]);
		expect(rejected.code).toBe(1);
		expect(rejected.stderr).toContain('only the current named session');
	}));

test('unreadable sections are explicit and credential-shaped errors are redacted', async () => {
	const bundle = await collectDiagnostics(
		'morgan',
		'2026-11-06T00:00:00.000Z',
		() => Promise.reject(new Error(`token=${secret}`)),
		{
			prerequisites: () => Promise.resolve([]),
			providers: () => Promise.reject(new Error(`token=${secret}`)),
			launch: () => Promise.reject(new Error('Launch unavailable.')),
			presence: () => Promise.reject(new Error('Presence unavailable.')),
			mail: () => Promise.reject(new Error('Mail unavailable.')),
			work: () => Promise.reject(new Error('Work unavailable.')),
			faults: () => Promise.reject(new Error('Faults unavailable.')),
			history: () => Promise.reject(new Error('History unavailable.')),
		},
	);
	expect(bundle.sections.build).toMatchObject({ status: 'unavailable' });
	expect(bundle.sections.providerClis).toMatchObject({ status: 'unavailable' });
	expect(JSON.stringify(bundle)).not.toContain(secret);
	expect(bundle.summary).toContain('build');
});

test('every source is read, but planted token, home path and message body stay out of the bundle', async () => {
	const token = ['sk', 'test0123456789abcdef'].join('-');
	const telegramToken = ['123456789', 'a'.repeat(35)].join(':');
	const accessKey = ['AK', 'IA', 'A'.repeat(16)].join('');
	const body = 'PRIVATE_MESSAGE_BODY_29cb75';
	const msysHome = [
		'',
		'c',
		'Users',
		'tester',
		'.summon',
		'team-default',
		'mailboxes',
		'peer',
		'a.json',
	].join('/');
	const msysRepo = '/d/applications/private-repo/config.json';
	const uncHost = '\\\\PRIVATE-HOST\\share\\secret.txt';
	const poison = [
		token,
		homedir(),
		msysHome,
		msysRepo,
		telegramToken,
		accessKey,
		uncHost,
		body,
	].join(' ');
	const at = '2026-11-07T11:00:00.000Z';
	const seen: string[] = [];
	const bundle = await collectDiagnostics(
		'morgan',
		'2026-11-06T11:00:00.000Z',
		() => {
			seen.push('build');
			return Promise.resolve({
				kind: 'test',
				version: '1.0.4',
				revision: '7466aa1',
				buildId: '1234567890',
				builtAt: at,
				messageBody: poison,
			});
		},
		{
			prerequisites: () => {
				seen.push('prerequisites');
				return Promise.resolve([
					{ id: 'bun', status: 'available', detail: poison },
				] as Awaited<ReturnType<DiagnosticSources['prerequisites']>>);
			},
			providers: () => {
				seen.push('providers');
				return Promise.resolve([
					{ provider: 'codex', status: 'available', detail: poison },
				] as Awaited<ReturnType<DiagnosticSources['providers']>>);
			},
			launch: () => {
				seen.push('launch');
				return Promise.resolve({
					current: true,
					observedAt: at,
					windowStartedAt: at,
					members: [
						{
							slug: 'morgan',
							provider: 'codex',
							launch: { phase: 'ready', since: at, evidence: poison },
						},
						{
							slug: 'alice',
							provider: 'claude',
							launch: { phase: 'ready', since: at, evidence: poison },
						},
					],
				} as unknown as Awaited<ReturnType<DiagnosticSources['launch']>>);
			},
			presence: () => {
				seen.push('presence');
				return Promise.resolve([
					{
						slug: 'morgan',
						name: 'Morgan',
						provider: 'codex',
						state: 'online',
						reason: poison,
						observedAt: at,
						hibernated: false,
					},
					{
						slug: 'alice',
						name: poison,
						provider: 'claude',
						state: 'online',
						reason: poison,
						observedAt: at,
						hibernated: false,
					},
				] as Awaited<ReturnType<DiagnosticSources['presence']>>);
			},
			mail: () => {
				seen.push('mail');
				return Promise.resolve({
					state: 'live',
					readinessConfirmed: true,
					reason: poison,
					wakeErrors: [],
					wakeDelivery: { latest: null, unresolved: 0 },
					messageBody: poison,
				});
			},
			work: () => {
				seen.push('work');
				return Promise.resolve({
					activity: { currentLaunch: true, state: 'busy', workingOn: poison },
					cards: { count: 1, items: [{ text: poison }] },
					mail: { pending: 1, unread: 1, invalid: [] },
					holds: { pending: 0, decisions: 0 },
					checkpoint: { phase: 'page', page: 1, pages: 1 },
					schedules: { counts: { unfinished: 0, due: 0, next: 0, paused: 0 } },
					rest: null,
					headDown: null,
					roomAcknowledgedThrough: 1,
				} as unknown as Awaited<ReturnType<DiagnosticSources['work']>>);
			},
			faults: () => {
				seen.push('faults');
				return Promise.resolve({
					more: false,
					matchingOccurrences: 1,
					entries: [
						{ at, lastAt: at, level: 'error', source: 'test', count: 1, text: poison },
					],
				} as Awaited<ReturnType<DiagnosticSources['faults']>>);
			},
			history: () => {
				seen.push('history');
				return Promise.resolve({
					more: false,
					entries: [
						{
							at,
							state: 'started',
							reason: 'unknown',
							provider: 'codex',
							messageBody: poison,
						},
					],
				} as unknown as Awaited<ReturnType<DiagnosticSources['history']>>);
			},
		},
		at,
	);
	expect(seen).toEqual([
		'build',
		'prerequisites',
		'providers',
		'launch',
		'presence',
		'mail',
		'work',
		'faults',
		'history',
	]);
	const raw = JSON.stringify(bundle);
	expect(raw).not.toContain(token);
	expect(raw).not.toContain(homedir());
	expect(raw).not.toContain(msysHome);
	expect(raw).not.toContain(msysRepo);
	expect(raw).not.toContain(telegramToken);
	expect(raw).not.toContain(accessKey);
	expect(raw).not.toContain(uncHost);
	expect(raw).not.toContain(body);
	for (const section of Object.values(bundle.sections)) expect(section.status).toBe('available');
});
