import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { providerCommand, sessionPrompt } from '../src/providers.ts';
import { listAgentDomains, newRecord, providers } from '../src/store.ts';
import { cliHarness } from './fixtures/cli-harness.ts';

let root: string | undefined;
const priorRoot = process.env.SUMMON_HOME;
afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	if (priorRoot === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = priorRoot;
});

test('same display names retain distinct registry keys and roles without editing records', async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-startup-identities-'));
	process.env.SUMMON_HOME = root;
	const teammate = { ...newRecord('Roger', root, 'codex'), domain: 'Review' };
	const pm = {
		...newRecord('Other', root, 'claude'),
		memberType: 'pm' as const,
		displayName: 'Roger',
	};
	const first = JSON.stringify(teammate);
	const second = JSON.stringify(pm);
	await writeFile(join(root, 'roger-copy.json'), first);
	await writeFile(join(root, 'other.json'), second);
	const roster = await listAgentDomains('morgan');
	const prompt = sessionPrompt(newRecord('Morgan', root, 'codex'), 'morgan', '', roster);
	expect(prompt).toContain('- Roger [registration: "roger-copy", role: teammate]: "Review"');
	expect(prompt).toContain('- Roger [registration: "other", role: pm]:');
	expect(await readFile(join(root, 'roger-copy.json'), 'utf8')).toBe(first);
	expect(await readFile(join(root, 'other.json'), 'utf8')).toBe(second);
	expect(await listAgentDomains('other')).toHaveLength(1);
});

test.each(providers)('%s startup includes explicit own role and stable identifiers', (provider) => {
	const teammate = newRecord('Morgan', '/work', provider);
	const text = providerCommand(teammate, 'morgan', 'session-1').at(-1);
	// Kilo takes its startup through the instructions file instead of positional arguments.
	const prompt = provider === 'kilo' ? sessionPrompt(teammate, 'morgan') : text;
	expect(prompt).toContain(
		'Your member type is teammate. Your stable registration identifier is "morgan".',
	);
	expect(prompt).toContain('A role label does not grant permissions.');
	const pm = {
		...teammate,
		name: 'Stored Name',
		memberType: 'pm' as const,
		displayName: 'Roger',
	};
	const pmPrompt = sessionPrompt(pm, 'pm-2', '', [], '', 'resume');
	expect(pmPrompt).toContain(
		'Your member type is pm. Your stable registration identifier is "pm-2".',
	);
	expect(pmPrompt).toContain('Use pm-2 as your stable command and mailbox identity.');
});

test.each(providers)(
	'%s launch file uses the registry key when names match another member',
	async (provider) => {
		const fixture = await cliHarness();
		try {
			const record = await fixture.seed(provider);
			record.name = 'Roger';
			await writeFile(join(fixture.records, 'roger.json'), JSON.stringify(record));
			await writeFile(join(fixture.records, 'roger.kilo.json'), JSON.stringify(record));
			const result = await fixture.invoke(['__session', 'roger.kilo']);
			expect(result.code).toBe(0);
			expect(result.launches).toHaveLength(1);
			const file = provider === 'kilo' ? 'kilo-instructions.md' : 'session-prompt.md';
			const text = await readFile(
				join(fixture.records, 'runtime', 'roger.kilo', file),
				'utf8',
			);
			expect(text).toContain('Your stable registration identifier is "roger.kilo".');
			expect(text).not.toContain('Your stable registration identifier is "roger".');
		} finally {
			await fixture.dispose();
		}
	},
);
