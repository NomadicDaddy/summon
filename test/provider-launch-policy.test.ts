import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { providers } from '../src/store.ts';
import { cliHarness } from './fixtures/cli-harness.ts';

for (const provider of providers) {
	test(`${provider} launches and resumes normally even with obsolete guard settings`, async () => {
		const fixture = await cliHarness();
		try {
			await mkdir(join(fixture.records, 'settings'));
			await writeFile(
				join(fixture.records, 'settings', 'storage-guard.json'),
				'{"version":1,"enabled":true}',
			);
			const fresh = await fixture.invoke(['member', '--using', provider, '--same-window']);
			await fixture.seed(provider);
			const resumed = await fixture.invoke(['__session', 'member']);
			for (const result of [fresh, resumed]) {
				expect(result.code).toBe(0);
				const command = result.launches[0]?.cmd ?? [];
				expect(command[0]).toBe(provider);
				expect(command.join(' ')).not.toMatch(
					/summon-guard|storage-guard|guarded-provider|default_permissions=|--no-daemon/,
				);
			}
		} finally {
			await fixture.dispose();
		}
	}, 15_000);
}
