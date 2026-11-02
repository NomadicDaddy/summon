import { lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';

import { atomicWrite, locked, missing } from './mail-files.ts';
import {
	defaultTeamDirectory,
	sameStoragePath,
	storageRoot,
	teamsBaseRoot,
} from './storage-root.ts';

const markerName = '.team-layout.json';
const markerSchema = z
	.object({
		version: z.literal(1),
		defaultTeam: z.literal(defaultTeamDirectory),
		state: z.enum(['pending', 'ready']),
	})
	.strict();
const legacyNames = new Set([
	'agents.md',
	'team-rules.md',
	'team-rules-provenance.md',
	'mailboxes',
	'attention',
	'board',
	'diary',
	'room',
	'communications',
	'integrations',
	'settings',
	'claims',
	'schedules',
	'notepad',
	'runtime',
	'scratch',
	'archives',
	'logs',
	'registration-proposals',
	'compactions',
]);

function refuse(reason: string): never {
	throw new Error(
		`Team storage is not ready: ${reason}. Keep readers closed and use the separately approved offline move/restore plan; startup never migrates existing data.`,
	);
}

/** No directory link may redirect a layout check or its subsequent initializer. */
async function plainPath(path: string): Promise<void> {
	for (let current = resolve(path); ; current = dirname(current)) {
		const entry = await lstat(current).catch((error: unknown) => {
			if (missing(error)) return undefined;
			throw error;
		});
		if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
			refuse(`storage must use real directories (${current})`);
		if (dirname(current) === current) return;
	}
}

async function readMarker(base: string) {
	const path = join(base, markerName);
	const info = await lstat(path).catch((error: unknown) => {
		if (missing(error)) return undefined;
		throw error;
	});
	if (!info) return undefined;
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024)
		refuse('the layout marker is redirected or is not a regular single-link file');
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
	} catch {
		refuse('the layout marker cannot be read as JSON');
	}
	const parsed = markerSchema.safeParse(raw);
	if (!parsed.success) refuse('the layout marker is unsupported or malformed');
	if (parsed.data.state !== 'ready') refuse('an offline move or initialization is incomplete');
	return parsed.data;
}

/** A build rollback must never strand the moved store behind an older root resolver. */
export async function requireCompatibleTeamLayout(base: string, supported: unknown): Promise<void> {
	await plainPath(base);
	const marker = await readMarker(base);
	if (supported !== undefined) await checkBase(base);
	if (marker && supported !== marker.version)
		refuse(
			'the selected build does not support this layout; restore matching data and build offline',
		);
}

async function entriesAt(base: string) {
	return readdir(base, { withFileTypes: true }).catch((error: unknown) => {
		if (missing(error)) return [];
		throw error;
	});
}

function layoutWorkFile(name: string): boolean {
	return (
		name === `${markerName}.lock` ||
		/^\.team-layout\.json\.lock\.[a-f0-9-]+\.(pending|reaped)$/.test(name)
	);
}

/** A missing marker is fresh only when no old default data or destination exists. */
async function checkBase(base: string): Promise<boolean> {
	const marker = await readMarker(base);
	for (const entry of await entriesAt(base)) {
		const name = entry.name.toLowerCase();
		if (entry.name === markerName || layoutWorkFile(entry.name)) continue;
		if (legacyNames.has(name) || /^[a-z0-9][a-z0-9._-]{0,63}\.json$/i.test(entry.name))
			refuse(`legacy default-team data remains at the teams base (${entry.name})`);
		if (marker) continue; // The exact operator plan classifies preserved unknown remnants.
		if (
			entry.isDirectory() &&
			!entry.isSymbolicLink() &&
			(name === 'maintenance' || (name.startsWith('team-') && name !== defaultTeamDirectory))
		)
			continue;
		refuse(`the unmarked teams base contains ${entry.name}`);
	}
	if (marker) {
		const root = join(base, defaultTeamDirectory);
		await plainPath(root);
		const entry = await lstat(root).catch((error: unknown) => {
			if (missing(error)) return undefined;
			throw error;
		});
		if (!entry?.isDirectory()) refuse('the marked default-team directory is missing');
	}
	return marker !== undefined;
}

/** Read-only preflight, including routes that deliberately skip initializeStore. */
export async function assertStorageLayout(): Promise<void> {
	const root = storageRoot();
	const base = teamsBaseRoot();
	if (sameStoragePath(root, base)) refuse('SUMMON_HOME selects the teams base, not a team');
	await plainPath(root);
	if (process.env.SUMMON_TEAMS_HOME) await plainPath(base);
	const managed =
		sameStoragePath(dirname(root), base) && basename(root).toLowerCase().startsWith('team-');
	if (!managed) return; // An explicitly selected standalone custom store keeps its exact root.
	await plainPath(base);
	const isDefault = sameStoragePath(root, join(base, defaultTeamDirectory));
	if (!isDefault) {
		await readMarker(base); // A pending base operation fences named teams as well.
		return;
	}
	await checkBase(base);
}

/** Only an empty/default-free installation may be initialized automatically. */
export async function prepareStorageLayout(): Promise<void> {
	await assertStorageLayout();
	const base = teamsBaseRoot();
	const root = storageRoot();
	if (!sameStoragePath(root, join(base, defaultTeamDirectory))) return;
	await locked(join(base, `${markerName}.lock`), async () => {
		await assertStorageLayout();
		if (await readMarker(base)) return;
		await atomicWrite(
			join(base, markerName),
			JSON.stringify({ version: 1, defaultTeam: defaultTeamDirectory, state: 'pending' }),
		);
		await mkdir(root, { mode: 0o700 });
		await atomicWrite(
			join(base, markerName),
			JSON.stringify({ version: 1, defaultTeam: defaultTeamDirectory, state: 'ready' }),
		);
	});
}
