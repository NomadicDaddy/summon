import { expect, spyOn, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sessionPrompt } from '../src/providers.ts';
import { newRecord, providers } from '../src/store.ts';
import { teamRules, validateTeamRules } from '../src/team-rules.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

/** `count` sourced rules, two lines each, with `padding` characters added to the first rule. */
function sourcedRules(count: number, padding = 0): string {
	return Array.from(
		{ length: count },
		(_, i) => `- Rule ${i}.${i ? '' : 'x'.repeat(padding)}\n  source: #${i + 1} "rule ${i}"`,
	).join('\n');
}

/** Exactly 40 lines and `characters` characters. */
function fortyLines(characters: number): string {
	return sourcedRules(20, characters - sourcedRules(20).length);
}

async function withRules<T>(rules: string, body: (root: string) => T | Promise<T>): Promise<T> {
	const h = await mailHarness();
	const previousRoot = process.env.SUMMON_HOME;
	try {
		process.env.SUMMON_HOME = h.records;
		await writeFile(join(h.records, 'team-rules.md'), rules);
		return await body(h.root);
	} finally {
		if (previousRoot === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previousRoot;
		await h.dispose();
	}
}

function loadWithNotes(): { rules: string; notes: string[] } {
	const notes: string[] = [];
	return { rules: teamRules((note) => notes.push(note)), notes };
}

test('rules exactly at both limits load without a warning', async () => {
	const rules = fortyLines(8000);
	expect(rules.split('\n')).toHaveLength(40);
	expect(rules).toHaveLength(8000);
	validateTeamRules(rules);
	await withRules(rules, () => {
		expect(loadWithNotes()).toEqual({ rules, notes: [] });
	});
});

test('one line over the budget warns at start and keeps every rule', async () => {
	const rules = `${sourcedRules(20)}\nOne line too many.`;
	expect(() => validateTeamRules(rules)).toThrow('41 lines (limit 40)');
	await withRules(rules, () => {
		const loaded = loadWithNotes();
		expect(loaded.rules).toBe(rules);
		expect(loaded.notes).toEqual([
			'Team rules exceed their prompt budget: 41 lines (limit 40). Every rule is still included; ask the rules maintainer to shorten them.',
		]);
	});
});

test('one character over the budget warns at start and keeps every rule', async () => {
	const rules = fortyLines(8001);
	expect(() => validateTeamRules(rules)).toThrow('8001 characters (limit 8000)');
	await withRules(rules, () => {
		const loaded = loadWithNotes();
		expect(loaded.rules).toBe(rules);
		expect(loaded.notes).toHaveLength(1);
		expect(loaded.notes[0]).toContain('8001 characters (limit 8000)');
	});
});

test('both limits over are named together', async () => {
	const rules = `${fortyLines(8001)}\nOne line too many.`;
	expect(rules.length).toBeGreaterThan(8000);
	await withRules(rules, () => {
		expect(loadWithNotes().notes[0]).toContain(
			`41 lines (limit 40), ${rules.length} characters (limit 8000).`,
		);
	});
});

test('every provider gets over-budget rules in full, before notes, with one warning each', async () => {
	const rules = fortyLines(8500);
	const warning = spyOn(console, 'warn').mockImplementation(() => {});
	try {
		await withRules(rules, (root) => {
			for (const provider of providers) {
				const prompt = sessionPrompt(
					newRecord('alpha', root, provider),
					'alpha',
					'PERSONAL NOTE',
				);
				expect(prompt.indexOf(rules)).toBeGreaterThan(0);
				expect(prompt.indexOf(rules)).toBeLessThan(prompt.indexOf('PERSONAL NOTE'));
			}
		});
		expect(warning).toHaveBeenCalledTimes(providers.length);
		expect(String(warning.mock.calls[0]?.[0])).toContain('8500 characters (limit 8000)');
	} finally {
		warning.mockRestore();
	}
});

test('an unsourced or entry-free file over the budget still refuses the start', async () => {
	const unsourced = `${fortyLines(8100)}\n- No source here.`;
	await withRules(unsourced, () => {
		const notes: string[] = [];
		expect(() => teamRules((note) => notes.push(note))).toThrow(
			'Each team rule needs its own source or earned correction.',
		);
		expect(notes).toEqual([]);
	});
	const entryFree = 'Prose only.\n'.repeat(45);
	await withRules(entryFree, () => {
		expect(() => teamRules(() => {})).toThrow('Team rules contain no sourced entries.');
	});
});
