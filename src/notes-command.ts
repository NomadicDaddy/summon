import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

import { readActivity } from './agent-activity.ts';
import { atomicWrite, locked, missing, optionalText } from './mail-files.ts';
import { currentAgent } from './mail-identity.ts';
import { assertNotesLimit } from './notes-limit.ts';
import { loadAgent, notesPath, storageRoot } from './store.ts';

const MAX_BYTES = 512 * 1024;
const revision = (text: string): string => createHash('sha256').update(text).digest('hex');
const edit = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/), text: z.string() }).strict();

async function regularNotes(path: string): Promise<boolean> {
	const root = await lstat(resolve(storageRoot()));
	if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Redirected notes storage.');
	const info = await lstat(path).catch((error: unknown) => {
		if (missing(error)) return undefined;
		throw error;
	});
	if (!info) return false;
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES)
		throw new Error('Notes must be a regular file within the 512 KiB safety limit.');
	return true;
}

/** Notes edits accept no caller-selected name, path or delete operation. */
export async function notesCommand(args: string[]): Promise<void> {
	if (args.length !== 1 || (args[0] !== 'read' && args[0] !== 'write'))
		throw new Error('Usage: summon --notes read | write (stdin JSON: revision, text)');
	const slug = currentAgent();
	if (!(await loadAgent(slug)) || (await readActivity(slug))?.nonce !== process.env.SUMMON_NONCE)
		throw new Error('Notes require the current registered launch.');
	const path = notesPath(slug);
	if (args[0] === 'read') {
		await regularNotes(path);
		const text = (await optionalText(path)) ?? '';
		console.log(JSON.stringify({ revision: revision(text), text }));
		return;
	}
	const input = await Bun.stdin.text();
	if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Notes request exceeds its limit.');
	const data = edit.parse(JSON.parse(input) as unknown);
	assertNotesLimit(data.text);
	await locked(`${path}.lock`, async () => {
		await regularNotes(path);
		const previous = (await optionalText(path)) ?? '';
		if (revision(previous) !== data.revision)
			throw new Error('Notes changed since read; read again and reconcile the edit.');
		await atomicWrite(path, data.text);
	});
	console.log(JSON.stringify({ revision: revision(data.text) }));
}
