import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { providers } from '../src/store.ts';
import { cliHarness } from './fixtures/cli-harness.ts';

let fixture: Awaited<ReturnType<typeof cliHarness>>;
beforeEach(async () => {
	fixture = await cliHarness();
});
afterEach(async () => {
	await fixture.dispose();
});

for (const scenario of ['malformed', 'collision'] as const)
	test.each([...providers])(
		`${scenario} operator identity keeps the actual %s startup available`,
		async (provider) => {
			const record = await fixture.seed(provider);
			await mkdir(join(fixture.records, 'settings'), { recursive: true });
			const identityPath = join(fixture.records, 'settings/operator-identity.json');
			const identity = {
				version: 1,
				display: 'Rae',
				aliases: [],
				mentionOnly: ['operator'],
				recipientAliases: ['op', 'me'],
			};
			const bytes =
				scenario === 'malformed'
					? 'PRIVATE_CANARY malformed JSON'
					: JSON.stringify(identity);
			await writeFile(identityPath, bytes);
			if (scenario === 'collision')
				await writeFile(
					join(fixture.records, 'intruder.json'),
					JSON.stringify({ ...record, name: 'Rae', sessions: [] }),
				);
			const result = await fixture.invoke(['member', '--same-window']);
			expect(result.code).toBe(0);
			expect(result.launches).toHaveLength(1);
			expect(result.stderr).toContain('Operator identity unavailable');
			expect(result.stderr).not.toContain('PRIVATE_CANARY');
			const file = provider === 'kilo' ? 'kilo-instructions.md' : 'session-prompt.md';
			expect(await readFile(join(fixture.records, 'runtime/member', file), 'utf8')).toContain(
				'"for":"Operator"',
			);
			expect(await readFile(identityPath, 'utf8')).toBe(bytes);
			expect((await fixture.saved()).provider).toBe(provider);
		},
	);
