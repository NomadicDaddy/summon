import { expect, test } from 'bun:test';
import { mkdir, readdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { checkClaim } from '../src/claims-checks.ts';
import { claimHash, type ClaimsReport, currentResults, parseClaims } from '../src/claims-model.ts';
import { sessionPrompt } from '../src/providers.ts';
import { newRecord, providers } from '../src/store.ts';
import { teamRules, validateTeamRules } from '../src/team-rules.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

test('rules follow team storage, reload changes, and precede notes for every provider', async () => {
	const h = await mailHarness();
	const previousRoot = process.env.SUMMON_HOME;
	try {
		process.env.SUMMON_HOME = h.records;
		expect(teamRules()).toBe('');
		expect(sessionPrompt(newRecord('alpha', h.root, 'codex'), 'alpha')).not.toContain(
			'Team rules (',
		);
		const rules = '- Use the test rule.\n  source: #1 "test rule"';
		await writeFile(join(h.records, 'team-rules.md'), rules);
		validateTeamRules(teamRules());
		expect(() => validateTeamRules('- Missing source')).toThrow();
		expect(() => validateTeamRules('x\n'.repeat(41))).toThrow();
		for (const provider of providers) {
			const prompt = sessionPrompt(
				newRecord('alpha', h.root, provider),
				'alpha',
				'PERSONAL NOTE',
			);
			expect(prompt.indexOf(rules)).toBeGreaterThan(0);
			expect(prompt.indexOf(rules)).toBeLessThan(prompt.indexOf('PERSONAL NOTE'));
		}
		await writeFile(
			join(h.records, 'team-rules.md'),
			rules.replaceAll('test rule', 'updated rule'),
		);
		expect(teamRules()).toContain('updated rule');
		process.env.SUMMON_HOME = h.root;
		expect(teamRules()).toBe('');
	} finally {
		if (previousRoot === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previousRoot;
		await h.dispose();
	}
});

test('claims use typed literals; changed and expired reports lose current evidence', () => {
	const source = '- FACT Tool available | verify: ["tool-version", "bun", "1.0.0"]';
	const claims = parseClaims(source);
	expect(() => parseClaims('- FACT Execute | verify: echo hi')).toThrow();
	expect(() => parseClaims('- DIRECTIVE Wrong | verify: [1]')).toThrow();
	const report = {
		owner: 'alpha',
		identity: 'caller',
		checkedAt: new Date().toISOString(),
		sourceHash: claimHash(source),
		meaning: '',
		results: [
			{
				id: claims[0]?.id ?? '',
				text: 'Tool available',
				state: 'NOT-CONTRADICTED' as const,
				reason: '',
			},
		],
	};
	expect(currentResults(claims, report, claimHash(source))[0]?.state).toBe('NOT-CONTRADICTED');
	expect(currentResults(claims, report, 'changed')[0]?.state).toBe('NEVER-CHECKED');
	expect(
		currentResults(claims, report, claimHash(source), Date.now() + 15 * 86400000)[0]?.state,
	).toBe('NEVER-CHECKED');
});

test('literal predicates bound paths, reject commands and distinguish existence from evidence', async () => {
	const h = await mailHarness();
	try {
		const path = join(h.root, 'evidence.txt');
		await writeFile(path, 'first\nexpected\n');
		await mkdir(join(h.root, 'target'));
		await symlink(
			join(h.root, 'target'),
			join(h.root, 'alias'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		const run = (check: unknown[], duty = false) =>
			checkClaim({ id: 'test', text: 'published', check, duty }, h.root);
		expect((await run(['file-exists', path])).state).toBe('WEAK');
		expect((await run(['file-exists', join(h.root, 'alias')])).state).toBe('UNVERIFIABLE');
		expect((await run(['file-contains', path, 'expected'])).state).toBe('NOT-CONTRADICTED');
		expect((await run(['file-line-equals', path, 2, 'other'])).state).toBe('DISPUTED');
		expect((await run(['file-exists', join(h.root, '..', 'outside')])).state).toBe(
			'UNVERIFIABLE',
		);
		expect((await run(['file-contains', join(h.root, '.env'), 'value'])).state).toBe(
			'UNVERIFIABLE',
		);
		expect((await run(['shell', 'echo injected'])).state).toBe('UNVERIFIABLE');
		expect((await run(['env-equals', 'API_TOKEN', 'guess'])).state).toBe('UNVERIFIABLE');
		expect((await run(['file-exists', path], true)).state).toBe('UNVERIFIABLE');
		expect((await run(['artifact-newer-than', path, 1], true)).state).toBe('NOT-CONTRADICTED');
		await utimes(path, new Date(0), new Date(0));
		expect((await run(['artifact-newer-than', path, 1], true)).state).toBe('DISPUTED');
		expect((await run(['artifact-newer-than', join(h.root, 'missing'), 1], true)).state).toBe(
			'UNVERIFIABLE',
		);
	} finally {
		await h.dispose();
	}
});

test('CLI enforces own verification, permits published peer review, and daily checkpoint is idempotent', async () => {
	const h = await mailHarness();
	try {
		await mkdir(join(h.records, 'claims'));
		await writeFile(
			join(h.records, 'claims/alpha.md'),
			'- FACT Bun installed | verify: ["tool-version", "bun", "1.0.0"]',
		);
		const first = await h.run(['--verify-claims'], 'alpha');
		expect(first.code).toBe(0);
		const parsed = JSON.parse(first.out) as ClaimsReport;
		expect(parsed.results[0]?.state).toBe('NOT-CONTRADICTED');
		expect(parsed.identity.length).toBeGreaterThan(0);
		expect((await h.run(['--verify-claims', 'alpha'], 'beta')).code).not.toBe(0);
		expect((await h.run(['--claims-report', 'alpha'], 'beta')).code).toBe(0);
		const report = await readFile(join(h.records, 'claims/alpha.report.json'), 'utf8');
		expect((await h.run(['--checkpoint'], 'alpha')).code).toBe(0);
		expect(await readFile(join(h.records, 'claims/alpha.report.json'), 'utf8')).toBe(report);
		await writeFile(join(h.records, 'claims/alpha.md'), 'malformed');
		const checkpoint = await h.run(['--checkpoint'], 'alpha');
		expect(checkpoint.code).toBe(0);
		expect(checkpoint.error).toContain('claims check unavailable');
	} finally {
		await h.dispose();
	}
});

test('halt defers dispute mail durably, then checkpoint sends it once', async () => {
	const h = await mailHarness();
	try {
		await mkdir(join(h.records, 'claims'));
		await writeFile(
			join(h.records, 'claims/alpha.md'),
			'- FACT Bun impossible version | verify: ["tool-version", "bun", "999.0.0"]',
		);
		expect((await h.run(['--comms', 'halt'])).code).toBe(0);
		const first = await h.run(['--verify-claims'], 'alpha');
		expect(first.code).toBe(0);
		const report = JSON.parse(first.out) as ClaimsReport;
		expect(report.results[0]?.state).toBe('DISPUTED');
		expect(report.notification?.claims).toHaveLength(1);
		const inbox = join(h.records, 'mailboxes/alpha/inbox');
		expect(await Bun.file(join(inbox, `${report.notification?.id}.md`)).exists()).toBe(false);
		expect((await h.run(['--comms', 'proceed'])).code).toBe(0);
		expect((await h.run(['--checkpoint'], 'alpha')).code).toBe(0);
		expect(await Bun.file(join(inbox, `${report.notification?.id}.md`)).exists()).toBe(true);
		expect((await h.run(['--verify-claims'], 'alpha')).code).toBe(0);
		expect((await readdir(inbox)).filter((file) => file.endsWith('.md'))).toHaveLength(1);
		const saved = JSON.parse(
			await readFile(join(h.records, 'claims/alpha.report.json'), 'utf8'),
		) as ClaimsReport;
		expect(saved.notification).toBeUndefined();
	} finally {
		await h.dispose();
	}
});

test('directive evidence requires structured human identity, not a peer quotation', async () => {
	const h = await mailHarness();
	try {
		await mkdir(join(h.records, 'claims'));
		await mkdir(join(h.records, 'room'));
		await writeFile(
			join(h.records, 'room/events.json'),
			JSON.stringify(
				['agent', 'user'].map((kind, i) => ({
					id: i + 1,
					at: new Date().toISOString(),
					sender: { kind, id: kind === 'user' ? 'operator' : 'beta' },
					text: 'approved',
					replyTo: null,
					source: 'test',
				})),
			),
		);
		await writeFile(
			join(h.records, 'claims/alpha.md'),
			'- DIRECTIVE Peer quote | source: [1, "approved"]\n- DIRECTIVE Human quote | source: [2, "approved"]',
		);
		const output = await h.run(['--verify-claims'], 'alpha');
		expect(output.code).toBe(0);
		const report = JSON.parse(output.out) as ClaimsReport;
		expect(report.results.map((r) => r.state)).toEqual(['DISPUTED', 'NOT-CONTRADICTED']);
	} finally {
		await h.dispose();
	}
});
