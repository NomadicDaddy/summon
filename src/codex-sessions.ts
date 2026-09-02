import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { open, readdir, stat } from 'node:fs/promises';

interface CodexSessionMeta {
	id: string;
	cwd: string;
}

export async function findNewCodexSession(
	cwd: string,
	startedAt: number,
): Promise<string | undefined> {
	const root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
	const files = await jsonlFiles(root).catch(() => []);
	const candidates = await Promise.all(
		files.map(async (file) => {
			try {
				const details = await stat(file);
				if (details.mtimeMs < startedAt - 5_000) return undefined;
				const meta = await readSessionMeta(file);
				if (!meta || normalizePath(meta.cwd) !== normalizePath(cwd)) return undefined;
				return { id: meta.id, mtimeMs: details.mtimeMs };
			} catch {
				return undefined;
			}
		}),
	);
	return candidates
		.filter((candidate) => candidate !== undefined)
		.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.id;
}

async function jsonlFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return jsonlFiles(path);
			return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : [];
		}),
	);
	return nested.flat();
}

async function readSessionMeta(path: string): Promise<CodexSessionMeta | undefined> {
	const file = await open(path, 'r');
	try {
		const buffer = Buffer.alloc(65_536);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
			if (!line.includes('session_meta')) continue;
			const parsed: unknown = JSON.parse(line);
			const meta = extractMeta(parsed);
			if (meta) return meta;
		}
		return undefined;
	} finally {
		await file.close();
	}
}

function extractMeta(value: unknown): CodexSessionMeta | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const event = value as Record<string, unknown>;
	if (event.type !== 'session_meta' || !event.payload || typeof event.payload !== 'object') {
		return undefined;
	}
	const payload = event.payload as Record<string, unknown>;
	return typeof payload.id === 'string' && typeof payload.cwd === 'string'
		? { id: payload.id, cwd: payload.cwd }
		: undefined;
}

function normalizePath(value: string): string {
	return resolve(value.replace(/^\\\\\?\\/, '')).toLowerCase();
}
