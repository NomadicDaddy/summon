import { createHash } from 'node:crypto';
import { lstat, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

import { atomicWrite, locked, missing, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';
import { parseOwner, processAlive } from './process-owner.ts';
import { defaultTeamDirectory, sameStoragePath, selectedTeamsBase } from './storage-root.ts';
import { storageRoot } from './store.ts';

const leaseSchema = z
	.object({
		version: z.literal(1),
		lockNonce: z.uuid(),
		nonce: z.string().regex(/^[a-z0-9-]+$/i),
		home: z.string().min(1),
		digest: z.string().regex(/^[a-f0-9]{64}$/),
		phase: z.enum(['prepared', 'published']),
		root: z.string().min(1).optional(),
	})
	.strict();

const digest = (body: string): string => createHash('sha256').update(body).digest('hex');
const hookPath = (home: string, name: string, nonce: string, root = storageRoot()): string =>
	join(home, 'hooks', `summon-turn-${digest(JSON.stringify([resolve(root), name, nonce]))}.json`);

/** A resumed native conversation is not proof that an old launch still owns its hook. */
export async function ownsGrokHook(name: string, nonce: string): Promise<boolean> {
	ownMailbox(name);
	const root = runtimePath(name);
	const lease = leaseSchema.safeParse(
		JSON.parse((await optionalText(join(root, 'grok-hook-lease.json'))) ?? 'null') as unknown,
	);
	if (!lease.success || lease.data.phase !== 'published' || lease.data.nonce !== nonce)
		return false;
	if (lease.data.root && !sameStoragePath(lease.data.root, storageRoot())) return false;
	const owner = parseOwner((await optionalText(join(root, 'session.lock/owner.json'))) ?? '');
	return !!owner && owner.nonce === lease.data.lockNonce && processAlive(owner.pid);
}

async function removeUnchanged(path: string, expected: string): Promise<void> {
	try {
		// A replacement, including a symlink, belongs to its author.
		if (!(await lstat(path)).isFile()) return;
		const body = await optionalText(path);
		if (body !== undefined && digest(body) === expected) await unlink(path);
	} catch (error: unknown) {
		if (!missing(error)) throw error;
	}
}

/** Recover only this name's recorded hook after the session lock excludes a surviving runner/provider. */
export async function publishGrokHook(
	name: string,
	nonce: string,
	home: string,
	body: string,
): Promise<() => Promise<void>> {
	ownMailbox(name);
	const root = runtimePath(name);
	const path = join(root, 'grok-hook-lease.json');
	const guard = `${path}.lock`;
	const canonicalHome = resolve(home);
	return locked(guard, async () => {
		const owner = parseOwner(
			(await optionalText(join(root, 'session.lock', 'owner.json'))) ?? '',
		);
		if (owner?.pid !== process.pid)
			throw new Error('Grok hook installation requires the owned session lock.');
		const previous = await optionalText(path);
		if (previous !== undefined) {
			let value: unknown;
			try {
				value = JSON.parse(previous) as unknown;
			} catch {
				throw new Error('Invalid Grok hook ownership; preserve it for inspection.');
			}
			const parsed = leaseSchema.safeParse(value);
			if (!parsed.success)
				throw new Error('Invalid Grok hook ownership; preserve it for inspection.');
			const lease = parsed.data;
			if (lease.lockNonce === owner.nonce)
				throw new Error('This session already owns a Grok hook.');
			if (lease.home !== canonicalHome)
				throw new Error(
					'Grok hook home changed; preserve previous ownership for inspection.',
				);
			const roots = [lease.root ?? storageRoot()];
			const base = selectedTeamsBase();
			// Version-one leases moved by the default-team migration did not retain their root.
			if (
				!lease.root &&
				base &&
				sameStoragePath(storageRoot(), join(base, defaultTeamDirectory))
			)
				roots.push(base);
			for (const oldRoot of new Set(roots)) {
				const oldHook = hookPath(canonicalHome, name, lease.nonce, oldRoot);
				if (lease.phase === 'prepared' && (await optionalText(oldHook)) !== undefined)
					throw new Error(
						'Grok hook publication was interrupted; preserve it for inspection.',
					);
				if (lease.phase === 'published') await removeUnchanged(oldHook, lease.digest);
			}
		}
		const lease = leaseSchema.parse({
			version: 1,
			lockNonce: owner.nonce,
			nonce,
			home: canonicalHome,
			digest: digest(body),
			phase: 'prepared',
			root: resolve(storageRoot()),
		});
		const prepared = JSON.stringify(lease);
		const published = JSON.stringify({ ...lease, phase: 'published' });
		const target = hookPath(canonicalHome, name, nonce);
		await mkdir(join(canonicalHome, 'hooks'), { recursive: true });
		await atomicWrite(path, prepared);
		let created = false;
		try {
			await writeFile(target, body, { flag: 'wx', mode: 0o600 });
			created = true;
			await atomicWrite(path, published);
		} catch (error: unknown) {
			if (created) await removeUnchanged(target, lease.digest);
			if ((await optionalText(path)) === prepared) await unlink(path);
			throw error;
		}
		return () =>
			locked(guard, async () => {
				// A late cleanup from an earlier launch cannot remove the new owner's file or lease.
				if ((await optionalText(path)) !== published) return;
				await removeUnchanged(target, lease.digest);
				await unlink(path);
			});
	});
}
