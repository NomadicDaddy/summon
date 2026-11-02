import { expect, test } from 'bun:test';

import { prerequisiteSummary } from '../src/desktop/cli-summary.ts';
import { runtimeRequirements, runtimeResults } from './fixtures/runtime-prerequisites.ts';

test('prerequisites name minimum versions and distinguish unavailable, missing and old tools', () => {
	for (const [status, wording] of [
		['missing', 'not found'],
		['outdated', 'update needed'],
		['unavailable', 'check failed'],
	] as const) {
		const text = prerequisiteSummary(runtimeRequirements, runtimeResults(status));
		for (const requirement of runtimeRequirements)
			expect(text).toContain(
				`${requirement.name} ${requirement.minimumVersion}+ (${wording}; official guide ${requirement.installUrl})`,
			);
		expect(text).toContain('then reopen Summon and refresh');
		expect(text).not.toContain('Open CLI setup');
		expect(text).not.toContain('versions found');
	}
});

test('missing results and empty catalog never produce a success summary', () => {
	expect(prerequisiteSummary(runtimeRequirements, [])).toContain('Bun 1.4.3+ (not checked;');
	expect(
		prerequisiteSummary(runtimeRequirements, runtimeResults('available').slice(0, 1)),
	).toContain('PowerShell 7.6.0+ (not checked;');
	expect(prerequisiteSummary([], runtimeResults('available'))).toBe(
		'Runtime prerequisites were not checked.',
	);
	expect(prerequisiteSummary(runtimeRequirements, runtimeResults('available'))).toBe(
		'Required runtime versions found.',
	);
});
