import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { collectDiagnostics } from '../src/diagnostics-collect.ts';
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
			providers: () => Promise.reject(new Error(`token=${secret}`)),
		},
	);
	expect(bundle.sections.build).toMatchObject({ status: 'unavailable' });
	expect(bundle.sections.providerClis).toMatchObject({ status: 'unavailable' });
	expect(JSON.stringify(bundle)).not.toContain(secret);
	expect(bundle.summary).toContain('build');
});
