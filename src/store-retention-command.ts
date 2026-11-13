import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { currentAgent } from './mail-identity.ts';
import { listSchedules } from './schedules.ts';
import { selectRetentionRow } from './store-retention-selector.ts';
import { storageRoot } from './store.ts';

const PAGE_SIZE = 10;
const VERSION = 1;

type Cursor = { version: number; owner: string | null; generation: string; offset: number };

async function stateBytes(path: string): Promise<Buffer> {
	try {
		return await readFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
		throw error;
	}
}

function digest(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function decodeCursor(token: string): Cursor {
	if (token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token))
		throw new Error('Invalid retention cursor.');
	let raw: unknown;
	try {
		raw = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
	} catch {
		throw new Error('Invalid retention cursor.');
	}
	if (!raw || typeof raw !== 'object') throw new Error('Invalid retention cursor.');
	const value = raw as Cursor;
	if (
		value.version !== VERSION ||
		(value.owner !== null && typeof value.owner !== 'string') ||
		!/^[a-f0-9]{64}$/.test(value.generation) ||
		!Number.isSafeInteger(value.offset) ||
		value.offset < 0 ||
		value.offset > 20000
	)
		throw new Error('Invalid retention cursor.');
	return value;
}

/** First live slice: enumerate exact scheduled-run IDs without changing state. */
export async function storeRetentionCommand(args: string[]): Promise<void> {
	if (
		args[0] !== 'preview' ||
		args.length > 3 ||
		(args.length === 3 && args[1] !== '--cursor') ||
		args.length === 2
	)
		throw new Error('Usage: summon --store-retention preview [--cursor <token>]');
	const token = args[2];
	if (args.length === 3 && !token) throw new Error('Invalid retention cursor.');
	const cursor = token ? decodeCursor(token) : undefined;
	const owner = process.env.SUMMON_AGENT ? currentAgent() : null;
	const path = join(storageRoot(), 'schedules', 'state.json');
	const before = await stateBytes(path);
	const state = await listSchedules();
	const after = await stateBytes(path);
	const generation = digest(before);
	if (!before.equals(after)) throw new Error('Schedule state changed during retention preview.');
	if (cursor && (cursor.generation !== generation || cursor.owner !== owner))
		throw new Error('Retention inputs changed; restart preview.');
	const offset = cursor?.offset ?? 0;
	if (offset > state.runs.length) throw new Error('Retention cursor is outside this state.');
	const rows = state.runs.slice(offset, offset + PAGE_SIZE).map((run) =>
		selectRetentionRow({
			family: 'schedule-run',
			path,
			owner: run.owner,
			identity: run.id,
			sha256: before.length ? generation : null,
			bytes: before.length,
			generationBefore: generation,
			generationAfter: generation,
			references: [],
			canonical: false,
			insideOwnerRoot: false,
			plainFile: false,
			singleLink: false,
			noOpenHandle: false,
			writerQuiescent: false,
			referenceGraphComplete: false,
			runId: run.id,
			stateBeforeHash: generation,
			stateAfterHash: null,
			terminal: run.status === 'complete' || run.status === 'failed',
			latestTerminal: true,
			successorDurable: false,
			exactIdOperationsSettled: false,
		}),
	);
	const nextOffset = offset + rows.length;
	const next =
		nextOffset < state.runs.length
			? Buffer.from(
					JSON.stringify({ version: VERSION, owner, generation, offset: nextOffset }),
				).toString('base64url')
			: null;
	console.log(
		JSON.stringify({
			version: VERSION,
			readOnly: true,
			applyAvailable: false,
			eligibleCount: rows.filter((row) => row.status === 'CANDIDATE').length,
			coverage: {
				'schedule-run': 'incomplete',
				mail: 'not-enumerated',
				wake: 'not-enumerated',
				'room-image': 'not-enumerated',
				compaction: 'not-enumerated',
			},
			rows,
			next,
			instruction:
				'Scheduled-run first slice only. All rows KEEP. No deletion manifest or savings claim.',
		}),
	);
}
