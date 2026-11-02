import { expect, test } from 'bun:test';

import type { CliStatus } from '../src/desktop/cli-status.ts';

import { firstRunSummary, setupSummary } from '../src/desktop/cli-summary.ts';
import { providerSetupCatalog } from '../src/provider-setup.ts';

const names = new Map(providerSetupCatalog.providers.map((setup) => [setup.provider, setup.name]));
const statuses = (...found: CliStatus['status'][]): CliStatus[] =>
	providerSetupCatalog.providers.map((setup, index) => ({
		detail: '',
		provider: setup.provider,
		status: found[index] ?? 'missing',
	}));

test('nothing installed reads as the first step, not as a fault', () => {
	const none = statuses();
	expect(setupSummary(none, names)).toBe(
		'None of the 4 supported CLIs found yet. Sign-in is not checked.',
	);
	const text = firstRunSummary(none, names);
	expect(text).toContain('where every new setup starts');
	expect(text).not.toMatch(/error|failed|missing/iu);
});

test('a CLI that is present but will not answer is not called uninstalled', () => {
	const text = firstRunSummary(statuses('unavailable'), names);
	expect(text).toContain('Could not be checked: Claude Code.');
	expect(text).not.toMatch(/install one|new setup/iu);
});

test('a mixed result names what was found and what was not, by product name', () => {
	const mixed = statuses('available', 'missing', 'unavailable', 'available');
	// The heading's line names what is missing instead of counting what was found (card 32f030f9).
	expect(setupSummary(mixed, names)).toBe(
		'Not found: Codex CLI. Could not be checked: Grok Build. Sign-in is not checked.',
	);
	expect(setupSummary(statuses('available', 'available', 'missing', 'available'), names)).toBe(
		'Not found: Grok Build. Sign-in is not checked.',
	);
	expect(setupSummary(statuses('available', 'available', 'available', 'available'), names)).toBe(
		'All 4 supported CLIs found. Sign-in is not checked.',
	);
	// Nothing found, but one would not answer: not a fresh machine, so each is named.
	expect(setupSummary(statuses('unavailable'), names)).toBe(
		'Not found: Codex CLI, Grok Build, Kilo CLI. Could not be checked: Claude Code. Sign-in is not checked.',
	);
	expect(firstRunSummary(mixed, names)).toBe(
		'Found here: Claude Code, Kilo CLI. Not found: Codex CLI. Could not be checked: Grok Build. Sign-in is not checked.',
	);
});

test('no summary ever says a CLI is ready or signed in', () => {
	for (const each of [statuses(), statuses('available', 'available', 'available', 'available')])
		for (const text of [setupSummary(each, names), firstRunSummary(each, names)])
			expect(text).not.toMatch(/ready|signed in|authenticated/iu);
});
