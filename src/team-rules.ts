import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { storageRoot } from './store.ts';

const MAX_LINES = 40;
const MAX_CHARACTERS = 8000;
const SOURCE = /^(source: #\d+ ".+"|earned: \d{4}-\d{2}-\d{2}, .+)$/;

function ruleLines(text: string): string[] {
	return text.trim().split(/\r?\n/);
}

function provenanceEntries(text: string): Set<string> {
	const ids = new Set<string>();
	for (const line of ruleLines(text)) {
		if (!line.trim() || line.startsWith('#')) continue;
		const entry = /^(R[1-9]\d*): (.+)$/.exec(line);
		const id = entry?.[1];
		if (!id || !SOURCE.test(entry[2] ?? ''))
			throw new Error(
				'Each provenance entry needs a rule number and source or earned correction.',
			);
		if (ids.has(id)) throw new Error(`Duplicate team rule provenance: ${id}.`);
		ids.add(id);
	}
	return ids;
}

function validateRuleSources(lines: readonly string[], provenance: string): void {
	const sources = provenanceEntries(provenance);
	const numbered = new Set<string>();
	let entries = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (!line.startsWith('- ')) continue;
		entries++;
		const id = /^- (R[1-9]\d*) .+$/.exec(line)?.[1];
		if (id) {
			if (numbered.has(id)) throw new Error(`Duplicate team rule number: ${id}.`);
			numbered.add(id);
			if (!sources.has(id))
				throw new Error(`Team rule ${id} needs its own provenance entry.`);
			continue;
		}
		if (/^- R\d/.test(line)) throw new Error('Malformed team rule number.');
		const next = lines[i + 1] ?? '';
		if (!next.startsWith('  ') || !SOURCE.test(next.slice(2)))
			throw new Error('Each team rule needs its own source or earned correction.');
	}
	for (const id of sources)
		if (!numbered.has(id)) throw new Error(`Team rule provenance ${id} has no matching rule.`);
	if (!entries) throw new Error('Team rules contain no sourced entries.');
}

/** Names each exceeded limit with its current size, or returns undefined within budget. */
function budgetOverrun(text: string): string | undefined {
	const lines = ruleLines(text).length;
	const exceeded = [
		...(lines > MAX_LINES ? [`${lines} lines (limit ${MAX_LINES})`] : []),
		...(text.length > MAX_CHARACTERS
			? [`${text.length} characters (limit ${MAX_CHARACTERS})`]
			: []),
	];
	return exceeded.length
		? `Team rules exceed their prompt budget: ${exceeded.join(', ')}.`
		: undefined;
}

/** The strict check for a rules author: malformed or unsourced rules and an overrun all throw. */
export function validateTeamRules(text: string, provenance = ''): void {
	const overrun = budgetOverrun(text);
	if (overrun) throw new Error(overrun);
	validateRuleSources(ruleLines(text), provenance);
}

function readRulesFile(name: string): string | undefined {
	try {
		return readFileSync(join(storageRoot(), name), 'utf8');
	} catch (error: unknown) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
		throw error;
	}
}

/**
 * Rules for a provider's startup prompt. Malformed or unsourced rules still refuse the start, but
 * an overrun only warns through `report`: every rule is kept, because dropping a directive would
 * be worse than a long prompt, and a start must not fail on length alone.
 */
export function teamRules(report: (note: string) => void = (note) => console.warn(note)): string {
	const text = readRulesFile('team-rules.md');
	const provenance = readRulesFile('team-rules-provenance.md') ?? '';
	if (text === undefined) {
		if (provenanceEntries(provenance).size) validateRuleSources([], provenance);
		return '';
	}
	validateRuleSources(ruleLines(text), provenance);
	const overrun = budgetOverrun(text);
	if (overrun)
		report(
			`${overrun} Every rule is still included; ask the rules maintainer to shorten them.`,
		);
	return text.trim();
}
