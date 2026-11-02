import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const)
	test(`${provider} registration consumes all new views with unchanged identity and read boundaries`, async () => {
		const fixture = await mailHarness();
		try {
			await writeFile(
				join(fixture.records, 'alpha.json'),
				JSON.stringify(newRecord('alpha', fixture.root, provider)),
			);
			const path = join(fixture.root, 'body.txt');
			await writeFile(path, `Literal \\a\n${provider}`);
			expect(
				(await fixture.run(['--mail', 'send-self', 'alpha', '--body-file', path], 'beta'))
					.code,
			).toBe(0);
			expect(
				(await fixture.run(['--room', 'send', `Search control ${provider}`], 'beta')).code,
			).toBe(0);
			const page = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as {
				receipt: string;
			};
			const state = await fixture.read('runtime/alpha/checkpoint.json');
			const text = await fixture.run(['--checkpoint', '--format', 'text'], 'alpha');
			expect(text.code).toBe(0);
			expect(text.out).toContain(page.receipt);
			expect(text.out).toContain(`Literal \\a\n${provider}`);
			const manifest = await fixture.run(
				['--checkpoint', 'manifest', '--format', 'text'],
				'alpha',
			);
			expect(manifest.code).toBe(0);
			const canonical = await fixture.run(['--checkpoint', 'manifest'], 'alpha');
			expect(canonical.code).toBe(0);
			const metadata = [...manifest.out.matchAll(/^items\[\d+\]: (\{.*\})$/gm)].map(
				(match) => JSON.parse(match[1] ?? '') as unknown,
			);
			expect(metadata).toEqual((JSON.parse(canonical.out) as { items: unknown[] }).items);
			expect(metadata).toEqual([
				expect.objectContaining({ source: 'room', firstPage: 0, lastPage: 0, parts: 1 }),
				expect.objectContaining({ source: 'mail', firstPage: 0, lastPage: 0, parts: 1 }),
			]);
			const view = await fixture.run(['--work'], 'alpha');
			expect(view.code).toBe(0);
			expect(JSON.parse(view.out) as unknown).toMatchObject({
				owner: 'alpha',
				mail: { unread: 1, pending: 1 },
				checkpoint: { phase: 'page' },
			});
			const found = await fixture.run(['--room', 'search', provider], 'alpha');
			expect(JSON.parse(found.out) as unknown).toMatchObject({
				matches: [{ id: 1 }],
				next: null,
			});
			expect((await fixture.run(['--room', 'show', '1'], 'alpha')).code).toBe(0);
			expect((await fixture.run(['--schedule', 'summary'], 'alpha')).code).toBe(0);
			expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(state);
			expect(
				await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists(),
			).toBe(false);
			await mkdir(join(fixture.records, 'runtime/alpha'), { recursive: true });
			await writeFile(
				join(fixture.records, 'runtime/alpha/test-launch.ready'),
				'test-launch',
			);
			expect(
				JSON.parse((await fixture.run(['--work'], 'alpha')).out) as unknown,
			).toMatchObject({ delivery: { readinessConfirmed: true } });
		} finally {
			await fixture.dispose();
		}
	});
