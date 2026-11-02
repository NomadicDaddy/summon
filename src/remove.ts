import { randomUUID } from 'node:crypto';
import {
	cp,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	rmdir,
	writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { removeHeadDownDelegate } from './head-down-access.ts';
import { locked, missing } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import { removeScheduleOwner } from './schedules.ts';
import { acquireSessionLock } from './session-lock.ts';
import { listAgentSlugs, loadAgent, slugFor, storageRoot, updateAgentRecord } from './store.ts';

function coverSlug(value: string): string | undefined {
	try {
		return slugFor(value);
	} catch {
		return undefined;
	}
}

/** Clear slug and saved display-name references after deletion; skip unrelated malformed covers. */
async function clearCoverReferences(slug: string, removedName?: string): Promise<void> {
	const matches = (value: string): boolean =>
		coverSlug(value) === slug || (!!removedName && value.trim() === removedName);
	const entries = await listAgentSlugs().catch(() => []);
	for (const entry of entries) {
		if (entry === slug) continue;
		const record = await loadAgent(entry).catch(() => undefined);
		const coverer = record?.backup?.trim();
		if (!record || !coverer || !matches(coverer)) continue;
		await updateAgentRecord(entry, (current) => {
			if (current.backup && matches(current.backup)) delete current.backup;
		});
	}
}

/** Refuse redirected storage paths before deleting any agent data. */
async function checkedPath(root: string, ...parts: string[]): Promise<string> {
	let target = root;
	for (const part of parts) {
		const parent = target;
		target = resolve(parent, part);
		if (dirname(target) !== parent) throw new Error('Removal path escapes the agent store.');
		try {
			if ((await lstat(target)).isSymbolicLink())
				throw new Error(`Refusing to remove redirected agent storage: ${target}`);
		} catch (error: unknown) {
			if (!missing(error)) throw error;
		}
	}
	return target;
}

/** A path's identity, or undefined when it is absent; a redirect is refused, never followed. */
async function pathIdentity(path: string): Promise<string | undefined> {
	try {
		const info = await lstat(path, { bigint: true });
		if (info.isSymbolicLink())
			throw new Error(`Refusing to remove redirected agent storage: ${path}`);
		return `${info.dev}:${info.ino}`;
	} catch (error: unknown) {
		if (missing(error)) return undefined;
		throw error;
	}
}

/**
 * The member's own scratch folders (Phillip #17710): scratch/<slug> and scratch/shared/<slug>.
 * A member registered as "shared" has no personal folder, because scratch/shared is everyone's.
 */
async function scratchFolders(root: string, slug: string) {
	const shared = await checkedPath(root, 'scratch', 'shared', slug);
	const paths = slug === 'shared' ? [shared] : [await checkedPath(root, 'scratch', slug), shared];
	return Promise.all(paths.map(async (path) => ({ identity: await pathIdentity(path), path })));
}

/** Delete removes the member's scratch first, so a failure keeps everything else for a retry. */
async function removeScratch(folders: { identity: string | undefined; path: string }[]) {
	const removed: string[] = [];
	const done = (none: string): string =>
		removed.length ? ` Already removed: ${removed.join(', ')}.` : none;
	for (const { identity, path } of folders) {
		const current = await pathIdentity(path);
		if (current === undefined) continue;
		if (current !== identity)
			throw new Error(
				`${path} changed after the removal check, so the teammate is still registered and removal can be retried.${done(' Nothing was removed.')}`,
			);
		await rm(path, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
			throw new Error(
				`Could not finish removing ${path} (some of its contents may be gone), so the teammate is still registered and removal can be retried.${done('')} ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		});
		removed.push(path);
	}
}

export async function removeAgent(name: string, archive = false): Promise<void> {
	operatorOnly();
	const slug = slugFor(name);
	const root = await realpath(storageRoot());
	const record = await checkedPath(root, `${slug}.json`);
	try {
		await lstat(record);
	} catch (error: unknown) {
		if (!missing(error)) throw error;
		throw new Error(`No agent named "${name}" exists.`, { cause: error });
	}
	const notes = await checkedPath(root, `${slug}.md`);
	const icon = await checkedPath(root, `${slug}.png`);
	const mailbox = await checkedPath(root, 'mailboxes', slug);
	const runtime = await checkedPath(root, 'runtime', slug);
	const attention = await checkedPath(root, 'attention');
	const claims = await checkedPath(root, 'claims', `${slug}.md`);
	const claimsReport = await checkedPath(root, 'claims', `${slug}.report.json`);
	// Delete only: Archive never reads scratch, so a redirected one cannot block it (Roger M1).
	const scratch = archive ? [] : await scratchFolders(root, slug);
	const lock = await acquireSessionLock(slug);
	if (!lock) throw new Error(`${name} is running. Close its session before removing it.`);
	try {
		const removedName = (await loadAgent(slug).catch(() => undefined))?.name.trim();
		// Delete only (Archive keeps scratch). Scratch goes before schedules are paused, so the
		// likeliest failure, a file held open, leaves the member exactly as it was.
		await removeScratch(scratch);
		const paused = await locked(`${claimsReport}.lock`, () =>
			removeScheduleOwner(slug, async () => {
				if (archive) {
					const archiveRoot = await checkedPath(root, 'archives');
					const destination = resolve(archiveRoot, `${slug}-${randomUUID()}`);
					await mkdir(destination, { recursive: true, mode: 0o700 });
					// Preserve durable identity and mail before removal. Runtime locks are not restorable state.
					for (const [source, target] of [
						[record, `${slug}.json`],
						[notes, `${slug}.md`],
						[icon, `${slug}.png`],
						[mailbox, 'mailbox'],
						[claims, 'claims.md'],
						[claimsReport, 'claims.report.json'],
					] as const) {
						try {
							await cp(source, resolve(destination, target), {
								recursive: true,
								errorOnExist: true,
								force: false,
							});
						} catch (error: unknown) {
							if (!missing(error)) throw error;
						}
					}
					await writeFile(
						resolve(destination, 'archive.json'),
						JSON.stringify({
							name: slug,
							archivedAt: new Date().toISOString(),
							status: 'saved',
						}),
					);
				}
				// AGENTS.md is shared instructions, including on case-insensitive filesystems.
				await rm(notes, { force: true });
				await rm(icon, { force: true });
				await rm(claims, { force: true });
				await rm(claimsReport, { force: true });
				await rm(mailbox, { recursive: true, force: true, maxRetries: 3 });
				for (const entry of await readdir(runtime)) {
					if (entry === 'session.lock') continue;
					const target = await checkedPath(root, 'runtime', slug, entry);
					await rm(target, { recursive: true, force: true, maxRetries: 3 });
				}
				const refs = await readdir(attention).catch((error: unknown) => {
					if (missing(error)) return [];
					throw error;
				});
				for (const entry of refs) {
					if (!entry.endsWith('.ref')) continue;
					const target = await checkedPath(root, 'attention', entry);
					if ((await readFile(target, 'utf8')).trim().toLowerCase() === slug)
						await rm(target);
				}
				// Keep the registration until cleanup succeeds so a failed removal can be retried.
				await removeHeadDownDelegate(slug, () => rm(record));
			}),
		);
		if (paused)
			console.log(
				`Paused ${paused} schedule(s); history retained. Resume explicitly with summon --schedule resume <id> after registering an owner.`,
			);
		// Deliberately not gated on the coverer's own session lock: a dangling coverer name is worse
		// than editing a record while its session runs, and records are read fresh at each launch.
		await clearCoverReferences(slug, removedName);
	} finally {
		await lock.release();
	}
	// Remove only an empty directory: never erase a new lock acquired after release.
	await rmdir(runtime).catch((error: unknown) => {
		if (!missing(error)) throw error;
	});
	console.log(`Removed ${name} and its summon files.`);
}
