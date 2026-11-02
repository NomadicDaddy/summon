import { expect, test } from 'bun:test';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const eslint = new ESLint({ cwd: root });

// Retained audit evidence: reports, historical source snapshots and executable probes.
const auditEvidence = [
	'.aidd/reports/carl/c2-r11-attempt-22762/c2r11-precheck.mjs',
	'.aidd/reports/spirit/20261010-rest-race.test.ts',
	'.aidd/reports/hugo/probe/collector.js',
	'.aidd/features/some-feature/snapshot.ts',
];

// Application source, tests, scripts and the root config stay linted.
const linted = ['src/store.ts', 'test/store.test.ts', 'scripts/test.ts', 'eslint.config.js'];

test('lint skips retained audit evidence under .aidd/', async () => {
	for (const path of auditEvidence) {
		expect({ ignored: await eslint.isPathIgnored(resolve(root, path)), path }).toEqual({
			ignored: true,
			path,
		});
	}
});

test('lint still covers source, tests, scripts and the root config', async () => {
	for (const path of linted) {
		expect({ ignored: await eslint.isPathIgnored(resolve(root, path)), path }).toEqual({
			ignored: false,
			path,
		});
		// Selected, not merely unignored: a config applies to the file.
		expect(await eslint.calculateConfigForFile(resolve(root, path))).toBeDefined();
	}
});
