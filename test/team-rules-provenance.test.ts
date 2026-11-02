import { expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sessionPrompt } from '../src/providers.ts';
import { assertStorageLayout } from '../src/storage-layout.ts';
import { newRecord, providers } from '../src/store.ts';
import { teamRules, validateTeamRules } from '../src/team-rules.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { storageLayoutHarness } from './fixtures/storage-layout.ts';

const rules = '- R1 Read the decision.\n- R20 Keep the evidence.';
const provenance = 'R20: earned: 2026-10-31, retained correction\nR1: source: #29819 "Yes"';
const inline = '- Existing rule.\n  source: #1 "Keep it"';

async function withFiles(
	ruleText: string | undefined,
	sourceText: string | undefined,
	body: (root: string, records: string) => Promise<void> | void,
): Promise<void> {
	const h = await mailHarness();
	const previous = process.env.SUMMON_HOME;
	try {
		process.env.SUMMON_HOME = h.records;
		if (ruleText !== undefined) await writeFile(join(h.records, 'team-rules.md'), ruleText);
		if (sourceText !== undefined)
			await writeFile(join(h.records, 'team-rules-provenance.md'), sourceText);
		await body(h.root, h.records);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await h.dispose();
	}
}

test('numbered rules match unordered provenance and reach every provider without sources', async () => {
	validateTeamRules(rules, provenance);
	await withFiles(rules, provenance, (root) => {
		expect(teamRules()).toBe(rules);
		for (const provider of providers) {
			const prompt = sessionPrompt(
				newRecord('alpha', root, provider),
				'alpha',
				'PERSONAL NOTE',
			);
			expect(prompt).toContain(rules);
			expect(prompt.indexOf(rules)).toBeLessThan(prompt.indexOf('PERSONAL NOTE'));
			expect(prompt).not.toContain('retained correction');
			expect(prompt).not.toContain('source: #29819');
			expect(prompt).not.toContain('team-rules-provenance.md');
		}
	});
});

test('inline rules remain valid alone and alongside numbered rules during the split', () => {
	validateTeamRules(inline);
	validateTeamRules(`${inline}\n${rules}`, provenance);
	validateTeamRules(rules, `# Provenance\n\n${provenance}\n`);
});

test('absent rules and provenance produce no directives', async () => {
	await withFiles(undefined, undefined, () => expect(teamRules()).toBe(''));
});

test('provenance left at the teams base refuses even when the layout marker is ready', async () => {
	const h = await storageLayoutHarness();
	try {
		await mkdir(h.selected, { recursive: true });
		await writeFile(
			join(h.base, '.team-layout.json'),
			JSON.stringify({
				version: 1,
				defaultTeam: 'team-default',
				state: 'ready',
			}),
		);
		await writeFile(join(h.base, 'team-rules-provenance.md'), provenance);
		await rejects(assertStorageLayout(), /legacy default-team data remains/);
		expect(await Bun.file(join(h.base, 'team-rules-provenance.md')).text()).toBe(provenance);
	} finally {
		await h.dispose();
	}
});

test.each([
	['missing file', rules, undefined, 'R1 needs its own provenance'],
	['missing entry', rules, 'R1: source: #1 "Yes"', 'R20 needs its own provenance'],
	[
		'duplicate rule',
		'- R1 One.\n- R1 Two.',
		'R1: source: #1 "Yes"',
		'Duplicate team rule number',
	],
	[
		'duplicate provenance',
		rules,
		`${provenance}\nR1: source: #2 "Again"`,
		'Duplicate team rule provenance',
	],
	['orphan entry', rules, `${provenance}\nR2: source: #2 "Orphan"`, 'R2 has no matching rule'],
	['orphan with no rules file', undefined, provenance, 'R20 has no matching rule'],
	[
		'inline rule cannot consume numbered provenance',
		inline,
		'R1: source: #1 "Yes"',
		'R1 has no matching rule',
	],
	[
		'numbered inline source cannot replace provenance',
		'- R1 One.\n  source: #1 "Yes"',
		'',
		'R1 needs its own provenance',
	],
	['unquoted source', rules, 'R1: source: #1 Yes', 'Each provenance entry needs'],
	['empty source', rules, 'R1: source: #1 ""', 'Each provenance entry needs'],
	[
		'malformed earned date',
		rules,
		'R1: earned: yesterday, correction',
		'Each provenance entry needs',
	],
	['empty earned correction', rules, 'R1: earned: 2026-10-31, ', 'Each provenance entry needs'],
	['unlabelled provenance', rules, 'source: #1 "Yes"', 'Each provenance entry needs'],
	['zero rule number', '- R0 One.', 'R1: source: #1 "Yes"', 'Malformed team rule number'],
	[
		'leading zero rule number',
		'- R01 One.',
		'R1: source: #1 "Yes"',
		'Malformed team rule number',
	],
	['empty numbered rule', '- R1 ', 'R1: source: #1 "Yes"', 'Malformed team rule number'],
] as const)(
	'%s refuses both author validation and startup',
	async (_label, text, source, message) => {
		expect(() => validateTeamRules(text ?? '', source)).toThrow(message);
		await withFiles(text, source, () => {
			expect(() => teamRules()).toThrow(message);
		});
	},
);

test('provenance reloads on every start and read failures remain visible', async () => {
	await withFiles(rules, provenance, async (_root, records) => {
		expect(teamRules()).toBe(rules);
		const path = join(records, 'team-rules-provenance.md');
		await writeFile(path, 'R1: source: #1 "Yes"');
		expect(() => teamRules()).toThrow('R20 needs its own provenance');
		await rm(path);
		await mkdir(path);
		expect(() => teamRules()).toThrow();
	});
});

test('large provenance does not consume the unchanged rules budget', async () => {
	const large = `${'# Evidence\n'.repeat(50)}R1: source: #1 "${'x'.repeat(8000)}"`;
	validateTeamRules('- R1 Keep the budget.', large);
	await withFiles('- R1 Keep the budget.', large, () => {
		const notes: string[] = [];
		expect(teamRules((note) => notes.push(note))).toBe('- R1 Keep the budget.');
		expect(notes).toEqual([]);
	});
});

test('numbered rules retain the exact author budget and startup warning behavior', async () => {
	const lines = Array.from({ length: 40 }, (_, i) => `- R${i + 1} Rule.`);
	const sources = lines.map((_, i) => `R${i + 1}: source: #${i + 1} "Yes"`).join('\n');
	lines[0] = `${lines[0] ?? ''}${'x'.repeat(8000 - lines.join('\n').length)}`;
	const boundary = lines.join('\n');
	validateTeamRules(boundary, sources);
	expect(() => validateTeamRules(`${boundary}x`, sources)).toThrow('8001 characters');
	expect(() => validateTeamRules(`${boundary}\nExtra prose.`, sources)).toThrow('41 lines');
	await withFiles(`${boundary}x`, sources, () => {
		const notes: string[] = [];
		expect(teamRules((note) => notes.push(note))).toBe(`${boundary}x`);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain('8001 characters (limit 8000)');
	});
});
