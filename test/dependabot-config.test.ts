import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

type Update = {
	'package-ecosystem': string;
	directory: string;
	schedule: { interval: string };
	'open-pull-requests-limit'?: number;
	'versioning-strategy'?: string;
	ignore?: { 'dependency-name': string; 'update-types'?: string[] }[];
	groups?: Record<string, { patterns: string[] }>;
};

function config(): { version: number; updates: Update[] } {
	return Bun.YAML.parse(readFileSync(join(root, '.github', 'dependabot.yml'), 'utf8')) as {
		version: number;
		updates: Update[];
	};
}

function entry(ecosystem: string): Update {
	const found = config().updates.filter((item) => item['package-ecosystem'] === ecosystem);
	expect(found).toHaveLength(1);
	return found[0] as Update;
}

test('dependabot proposes weekly bun and github-actions version updates from the root', () => {
	expect(config().version).toBe(2);
	expect(
		config()
			.updates.map((item) => item['package-ecosystem'])
			.sort(),
	).toEqual(['bun', 'github-actions']);
	for (const ecosystem of ['bun', 'github-actions']) {
		expect(entry(ecosystem).directory).toBe('/');
		expect(entry(ecosystem).schedule.interval).toBe('weekly');
	}
	expect(entry('bun')['open-pull-requests-limit']).toBe(5);
});

test('typescript is never moved: every typescript version update is ignored', () => {
	// Standing rule: typescript stays at exactly 6.0.3. An ignore without update-types covers every update.
	const rules = (entry('bun').ignore ?? []).filter(
		(rule) => rule['dependency-name'] === 'typescript',
	);
	expect(rules).toHaveLength(1);
	expect(rules[0]?.['update-types']).toBeUndefined();
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
		devDependencies?: Record<string, string>;
		dependencies?: Record<string, string>;
	};
	expect({ ...pkg.dependencies, ...pkg.devDependencies }.typescript).toBe('6.0.3');
});

test('bun updates set no versioning-strategy and group the lint and format tools', () => {
	// Exact pins in Dependabot's bun updates are expected, not documented; the first real PR checks them.
	expect(entry('bun')['versioning-strategy']).toBeUndefined();
	const patterns = Object.values(entry('bun').groups ?? {}).flatMap((group) => group.patterns);
	for (const name of ['eslint', '@eslint/js', 'typescript-eslint', 'eslint-plugin-*', 'prettier'])
		expect(patterns).toContain(name);
});
