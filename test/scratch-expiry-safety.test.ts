import { expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { link, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expireScratch, expiryLine } from '../src/scratch-retention.ts';
import {
	file,
	folder,
	fresh,
	old,
	scratchStore,
	SLOW,
	startedAt,
	tryRename,
	winTest,
} from './fixtures/scratch-store.ts';

const at = scratchStore();
const { scratch } = at;
const REDIRECTED = 'the scratch folder or a folder above it is redirected or is not a folder';

winTest(
	'a link or junction inside scratch is skipped, and what it points at is untouched',
	async () => {
		await file(join(at.outside, 'precious.txt'), old, 'keep me');
		await mkdir(scratch('ada'), { recursive: true });
		await symlink(at.outside, scratch('ada', 'escape'), 'junction');
		const report = await expireScratch(at.store, startedAt);
		expect(await readFile(join(at.outside, 'precious.txt'), 'utf8')).toBe('keep me');
		expect(existsSync(scratch('ada', 'escape'))).toBe(true);
		expect(report.skippedSample).toContainEqual({
			path: join('ada', 'escape'),
			reason: 'link, junction or reparse point, not followed',
		});
	},
	SLOW,
);

winTest(
	'a redirected scratch folder refuses the whole run',
	async () => {
		await rm(scratch(), { recursive: true });
		await file(join(at.outside, 'ada', 'old.txt'), old);
		await symlink(at.outside, scratch(), 'junction');
		const report = await expireScratch(at.store, startedAt);
		expect(report.refused).toBe(REDIRECTED);
		expect(existsSync(join(at.outside, 'ada', 'old.txt'))).toBe(true);
		expect(expiryLine(report)).toContain('Nothing was removed');
	},
	SLOW,
);

winTest(
	'a store reached through a junction, or any folder above it, refuses before traversal',
	async () => {
		// An ordinary scratch folder behind the link: only the ancestor chain is redirected.
		const real = join(at.outside, 'real-store');
		await file(join(real, 'scratch', 'ada', 'old.txt'), old);
		const linkedStore = join(at.base, 'linked-store');
		await symlink(real, linkedStore, 'junction');
		expect((await expireScratch(linkedStore, startedAt)).refused).toBe(REDIRECTED);
		const linkedParent = join(at.base, 'linked-parent');
		await symlink(at.outside, linkedParent, 'junction');
		const above = await expireScratch(join(linkedParent, 'real-store'), startedAt);
		expect(above.refused).toBe(REDIRECTED);
		expect(await readFile(join(real, 'scratch', 'ada', 'old.txt'), 'utf8')).toBe('x');
	},
	SLOW,
);

winTest(
	'a folder cannot be swapped for a junction between its check and its listing (measured: EBUSY)',
	async () => {
		await file(scratch('ada', 'swap', 'old.txt'), old);
		await file(join(at.outside, 'old.txt'), old, 'outside');
		const attempts: string[] = [];
		const report = await expireScratch(at.store, startedAt, {
			beforeList: (path) => {
				if (path !== scratch('ada', 'swap')) return;
				attempts.push(tryRename(path, scratch('ada', 'swap-moved')));
				attempts.push(tryRename(scratch('ada'), scratch('ada-moved')));
				attempts.push(tryRename(at.store, join(at.base, 'store-moved')));
			},
		});
		expect(attempts).toEqual(['EBUSY', 'EBUSY', 'EBUSY']);
		expect(await readFile(join(at.outside, 'old.txt'), 'utf8')).toBe('outside');
		expect(existsSync(scratch('ada', 'swap', 'old.txt'))).toBe(false);
		expect(report.removedFiles).toBe(1);
	},
	SLOW,
);

winTest(
	'the root and every ancestor stay in place while a delete is being set (measured: EBUSY)',
	async () => {
		const path = scratch('ada', 'pinned.txt');
		await file(path, old);
		const attempts: string[] = [];
		const report = await expireScratch(at.store, startedAt, {
			beforeDispose: () => {
				attempts.push(tryRename(scratch('ada'), join(at.base, 'escaped')));
				attempts.push(tryRename(scratch(), join(at.base, 'scratch-moved')));
				attempts.push(tryRename(at.store, join(at.base, 'store-moved')));
			},
		});
		expect(attempts).toEqual(['EBUSY', 'EBUSY', 'EBUSY']);
		expect(report.removedFiles).toBe(1);
		expect(existsSync(path)).toBe(false);
		expect(existsSync(join(at.base, 'escaped'))).toBe(false);
	},
	SLOW,
);

winTest(
	'a file changed, replaced, resized or removed after it was listed is not removed or counted',
	async () => {
		for (const name of ['changed', 'replaced', 'resized', 'vanished'])
			await file(scratch('ada', `${name}.txt`), old);
		const report = await expireScratch(at.store, startedAt, {
			beforeRemove: async (path) => {
				if (path.endsWith('changed.txt')) {
					await writeFile(path, 'y');
					await utimes(path, old, old);
				}
				if (path.endsWith('replaced.txt')) {
					await rm(path);
					await file(path, old);
				}
				if (path.endsWith('resized.txt')) await file(path, old, 'longer');
				if (path.endsWith('vanished.txt')) await rm(path);
			},
		});
		for (const name of ['changed', 'replaced', 'resized'])
			expect(existsSync(scratch('ada', `${name}.txt`))).toBe(true);
		expect(report.removedFiles).toBe(0);
		expect(report.disappeared).toBe(1);
		expect(report.skipped).toBe(3);
		expect(new Set(report.skippedSample.map((item) => item.reason))).toEqual(
			new Set(['changed during expiry']),
		);
	},
	SLOW,
);

winTest(
	'an old empty folder touched just before its removal is kept',
	async () => {
		await folder(scratch('ada', 'touched'), old);
		await folder(scratch('ada', 'untouched'), old);
		const report = await expireScratch(at.store, startedAt, {
			beforeRemove: async (path) => {
				if (path === scratch('ada', 'touched')) await utimes(path, fresh, fresh);
			},
		});
		expect(existsSync(scratch('ada', 'touched'))).toBe(true);
		expect(existsSync(scratch('ada', 'untouched'))).toBe(false);
		expect(report.removedDirectories).toBe(1);
		expect(report.skippedSample).toContainEqual({
			path: join('ada', 'touched'),
			reason: 'changed during expiry',
		});
	},
	SLOW,
);

winTest(
	'a folder that cannot be listed is reported, the rest continue, and no handle is left',
	async () => {
		const closed = scratch('ada', 'closed');
		await file(join(closed, 'old.txt'), old);
		await file(scratch('ada', 'old.txt'), old);
		const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
		const deny = Bun.spawnSync(['icacls', closed, '/deny', `${user}:(RD)`]);
		expect(deny.exitCode).toBe(0);
		try {
			const report = await expireScratch(at.store, startedAt);
			expect(report.skippedSample).toContainEqual({
				path: join('ada', 'closed'),
				reason: 'folder could not be read',
			});
			expect(report.removedFiles).toBe(1);
		} finally {
			Bun.spawnSync(['icacls', closed, '/remove:d', user]);
		}
		expect(tryRename(scratch('ada'), scratch('ada-after'))).toBe('renamed');
	},
	SLOW,
);

winTest(
	'a file with another hard link is skipped and both names keep the data',
	async () => {
		await file(scratch('ada', 'linked.txt'), old, 'shared data');
		await link(scratch('ada', 'linked.txt'), join(at.outside, 'linked.txt'));
		await utimes(scratch('ada', 'linked.txt'), old, old);
		const report = await expireScratch(at.store, startedAt);
		expect(existsSync(scratch('ada', 'linked.txt'))).toBe(true);
		expect(await readFile(join(at.outside, 'linked.txt'), 'utf8')).toBe('shared data');
		expect(report.skippedSample).toContainEqual({
			path: join('ada', 'linked.txt'),
			reason: 'has other hard links, not removed',
		});
	},
	SLOW,
);

for (const share of ['Read', 'ReadWrite, Delete']) {
	winTest(
		`a file held open by another process (sharing ${share}) is skipped and reported, not forced`,
		async () => {
			const path = scratch('ada', 'locked.txt');
			await file(path, old);
			const holder = Bun.spawn(
				[
					'pwsh',
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					`$f = [IO.File]::Open($env:LOCKED, 'Open', 'Read', '${share}'); 'ready'; Start-Sleep 30; $f.Close()`,
				],
				{ env: { ...process.env, LOCKED: path }, stdout: 'pipe', stderr: 'ignore' },
			);
			try {
				const { value } = await holder.stdout.getReader().read();
				expect(new TextDecoder().decode(value)).toContain('ready');
				const report = await expireScratch(at.store, startedAt);
				expect(existsSync(path)).toBe(true);
				expect(report.removedFiles).toBe(0);
				expect(report.skippedSample).toContainEqual({
					path: join('ada', 'locked.txt'),
					reason: 'in use or not permitted',
				});
			} finally {
				holder.kill();
				await holder.exited;
			}
		},
		SLOW,
	);
}

winTest(
	'measured limit: a handle holding only attribute access does not keep an old file',
	async () => {
		// Morgan 690ccccd: a metadata-only observer is not active use for this feature. Exclusive
		// open cannot see such a handle (CreateFileW: attribute access ignores sharing).
		const path = scratch('ada', 'attr.txt');
		await file(path, old);
		const holder = Bun.spawn(
			['bun', join(import.meta.dir, 'fixtures', 'attribute-holder.ts'), path],
			{ stdout: 'pipe' },
		);
		try {
			const ready = new TextDecoder().decode((await holder.stdout.getReader().read()).value);
			expect(ready).toContain('ready');
			const report = await expireScratch(at.store, startedAt);
			expect(report.removedFiles).toBe(1);
		} finally {
			holder.kill();
			await holder.exited;
		}
		expect(existsSync(path)).toBe(false);
	},
	SLOW,
);
