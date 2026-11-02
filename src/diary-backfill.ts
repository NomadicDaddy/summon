import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { DiaryBackfillPlan } from './diary-backfill-model.ts';
import type { DiaryEntry } from './diary.ts';

import { communicationSend } from './communication-gate.ts';
import { diaryBackfillPlan, diaryEntryHash } from './diary-backfill-model.ts';
import { DIARY_MAX_BYTES, diaryDocument, diaryEntry } from './diary-model.ts';
import { diaryPath, validateDiaryReferences } from './diary.ts';
import { localEvents } from './local-room.ts';
import { atomicWrite, locked, missing, optionalText } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import { loadAgent, slugFor, storageRoot } from './store.ts';

type Counts = { added: number; updated: number; removed: number; skipped: number };
type Stored = { entry: DiaryEntry; raw: unknown };

function sameOutcome(left: DiaryEntry, right: DiaryEntry): boolean {
	return (
		left.author.kind === right.author.kind &&
		left.author.id === right.author.id &&
		left.for === right.for &&
		left.task === right.task &&
		JSON.stringify([...left.room].sort((a, b) => a - b)) ===
			JSON.stringify([...right.room].sort((a, b) => a - b)) &&
		JSON.stringify([...left.board].sort()) === JSON.stringify([...right.board].sort())
	);
}

async function safePath(path: string, directory: boolean): Promise<void> {
	const info = await lstat(path).catch((error: unknown) => {
		if (missing(error)) return undefined;
		throw error;
	});
	if (info && (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())))
		throw new Error('Redirected or unexpected Diary path; backfill refused.');
}

async function planRoot(plan: DiaryBackfillPlan): Promise<string> {
	const root = resolve(storageRoot());
	const normalize = (value: string): string =>
		process.platform === 'win32' ? value.toLowerCase() : value;
	if (!isAbsolute(plan.teamRoot) || normalize(resolve(plan.teamRoot)) !== normalize(root))
		throw new Error('Backfill belongs to another team root.');
	await safePath(root, true);
	await safePath(join(root, 'diary'), true);
	await safePath(diaryPath(), false);
	await safePath(join(root, 'diary', 'backups'), true);
	return root;
}

async function prepare(plan: DiaryBackfillPlan) {
	const root = await planRoot(plan);
	const original = await optionalText(diaryPath());
	if (original !== undefined && Buffer.byteLength(original) > DIARY_MAX_BYTES)
		throw new Error('Diary storage exceeds its safety limit.');
	const value: unknown =
		original === undefined ? { version: 1, entries: [] } : JSON.parse(original);
	const document = diaryDocument.parse(value);
	if (
		!value ||
		typeof value !== 'object' ||
		!('entries' in value) ||
		!Array.isArray(value.entries)
	)
		throw new Error('Unexpected Diary document.');
	const stored = new Map<string, Stored>();
	for (const [index, entry] of document.entries.entries()) {
		if (stored.has(entry.id))
			throw new Error('Duplicate existing Diary identity; backfill refused.');
		stored.set(entry.id, { entry, raw: (value.entries as unknown[])[index] });
	}
	const counts: Counts = { added: 0, updated: 0, removed: 0, skipped: 0 };
	const authors = new Map<string, Counts>();
	const references: DiaryEntry[] = [];
	const now = new Date().toISOString();
	for (const operation of plan.operations) {
		const id = operation.kind === 'add' ? operation.entry.id : operation.id;
		const current = stored.get(id);
		let action: keyof Counts = 'skipped';
		let owner = current?.entry.author.id ?? 'already-absent';
		if (operation.kind === 'add') {
			const added = diaryEntry.parse({ ...operation.entry, at: current?.entry.at ?? now });
			owner = added.author.id;
			if (
				added.author.kind !== 'agent' ||
				slugFor(owner) !== owner ||
				(!(await loadAgent(owner)) &&
					!(await localEvents()).some(
						(event) => event.sender.kind === 'agent' && event.sender.id === owner,
					))
			)
				throw new Error('Backfill author must be registered or recorded in the Team Room.');
			if (current && diaryEntryHash(current.raw) !== diaryEntryHash(added))
				throw new Error('Backfill addition collides with an existing entry.');
			if (!current) {
				if ([...stored.values()].some((item) => sameOutcome(item.entry, added)))
					throw new Error(
						'Backfill outcome already exists under another identity; reconcile the plan.',
					);
				stored.set(id, { entry: added, raw: added });
				action = 'added';
			}
			references.push(added);
		} else if (operation.kind === 'update') {
			if (!current) throw new Error('Backfill update entry not found.');
			const already = Object.entries(operation.changes).every(
				([key, changed]) =>
					current.raw &&
					typeof current.raw === 'object' &&
					key in current.raw &&
					(current.raw as Record<string, unknown>)[key] === changed,
			);
			if (!already) {
				if (diaryEntryHash(current.raw) !== operation.expectedSha256)
					throw new Error('Diary entry changed since the plan; backfill refused.');
				const raw = { ...(current.raw as Record<string, unknown>), ...operation.changes };
				const updated = diaryEntry.parse(raw);
				stored.set(id, { entry: updated, raw });
				action = 'updated';
			}
			references.push(stored.get(id)?.entry ?? current.entry);
		} else if (current) {
			if (diaryEntryHash(current.raw) !== operation.expectedSha256)
				throw new Error('Diary removal entry changed since the plan; backfill refused.');
			stored.delete(id);
			action = 'removed';
		}
		counts[action]++;
		const author = authors.get(owner) ?? { added: 0, updated: 0, removed: 0, skipped: 0 };
		author[action]++;
		authors.set(owner, author);
	}
	await validateDiaryReferences(references);
	const next = JSON.stringify({
		version: 1,
		entries: [...stored.values()].map((item) => item.raw),
	});
	if (Buffer.byteLength(next) > DIARY_MAX_BYTES)
		throw new Error('Diary storage exceeds its safety limit.');
	return { root, original, next, counts, authors: Object.fromEntries(authors) };
}

/** Snapshot inspection only: no lock, backup or entry is written and no shutdown is proven. */
export async function preflightDiaryBackfill(value: unknown) {
	const plan = diaryBackfillPlan.parse(value);
	const result = await prepare(plan);
	return {
		planId: plan.id,
		approvalRoom: plan.approvalRoom,
		readOnly: true,
		snapshotOnly: true,
		processShutdownChecked: false,
		counts: result.counts,
		authors: result.authors,
	};
}

/** Only the operator can execute a prepared batch; updates cannot change attribution or identity. */
export async function applyDiaryBackfill(value: unknown) {
	operatorOnly();
	const plan = diaryBackfillPlan.parse(value);
	await planRoot(plan);
	return communicationSend('save the Diary entry', () =>
		locked(`${diaryPath()}.lock`, async () => {
			const result = await prepare(plan);
			const changed = result.counts.added + result.counts.updated + result.counts.removed;
			if (!changed)
				return {
					planId: plan.id,
					approvalRoom: plan.approvalRoom,
					backup: null,
					counts: result.counts,
					authors: result.authors,
				};
			const backup = join(result.root, 'diary', 'backups', `backfill-${plan.id}.json`);
			await safePath(backup, false);
			const before = result.original ?? JSON.stringify({ version: 1, entries: [] });
			const retained = await optionalText(backup);
			if (retained !== undefined && retained !== before)
				throw new Error('Backfill backup already differs; refusing to overwrite it.');
			if (retained === undefined) {
				await mkdir(join(result.root, 'diary', 'backups'), {
					recursive: true,
					mode: 0o700,
				});
				await atomicWrite(backup, before);
			}
			if ((await optionalText(backup)) !== before)
				throw new Error('Backfill backup verification failed.');
			await atomicWrite(diaryPath(), result.next);
			if ((await optionalText(diaryPath())) !== result.next)
				throw new Error(
					'Backfill write outcome could not be verified; retain the backup and do not repeat blindly.',
				);
			return {
				planId: plan.id,
				approvalRoom: plan.approvalRoom,
				backup,
				counts: result.counts,
				authors: result.authors,
			};
		}),
	);
}
