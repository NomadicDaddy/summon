import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { readActivity } from './agent-activity.ts';
import { readBoard } from './board.ts';
import { communicationSend } from './communication-gate.ts';
import { DIARY_MAX_BYTES, diaryDocument, diaryEntry, diaryFields } from './diary-model.ts';
import { localEvents } from './local-room.ts';
import { atomicWrite, locked, missing, optionalText } from './mail-files.ts';
import { currentAgent } from './mail-identity.ts';
import { loadAgent, storageRoot } from './store.ts';

export type DiaryEntry = z.infer<typeof diaryEntry>;
export interface DiaryPage {
	entries: DiaryEntry[];
	next: string | null;
}
export const diaryPath = (): string => join(storageRoot(), 'diary', 'entries.json');

async function entries(): Promise<DiaryEntry[]> {
	const info = await stat(diaryPath()).catch((error: unknown) => {
		if (!missing(error)) throw error;
		return undefined;
	});
	if (info && info.size > DIARY_MAX_BYTES)
		throw new Error('Diary storage exceeds its safety limit.');
	const raw = await optionalText(diaryPath());
	return raw ? diaryDocument.parse(JSON.parse(raw) as unknown).entries : [];
}

export async function validateDiaryReferences(
	items: Pick<DiaryEntry, 'room' | 'board'>[],
): Promise<void> {
	if (items.some((item) => item.room.length)) {
		const ids = new Set((await localEvents()).map((event) => event.id));
		if (items.some((item) => item.room.some((id) => !ids.has(id))))
			throw new Error('Diary room message not found.');
	}
	if (items.some((item) => item.board.length)) {
		const ids = new Set((await readBoard()).items.map((card) => card.id));
		if (items.some((item) => item.board.some((id) => !ids.has(id))))
			throw new Error('Diary Board card not found.');
	}
}

/** A stable entry cursor keeps older pages usable while new work is recorded. */
export async function readDiary(before?: unknown, search?: unknown): Promise<DiaryPage> {
	const cursor = z.uuid().optional().parse(before);
	const query = z.string().trim().max(300).optional().parse(search)?.toLowerCase() ?? '';
	const sorted = (await entries()).reverse().sort((a, b) => b.at.localeCompare(a.at));
	const index = cursor === undefined ? -1 : sorted.findIndex((item) => item.id === cursor);
	if (cursor !== undefined && index === -1) throw new Error('Diary cursor not found.');
	const matches = sorted
		.slice(index + 1)
		.filter(
			(item) =>
				item.task.toLowerCase().includes(query) ||
				item.author.id.toLowerCase().includes(query),
		);
	const page = matches.slice(0, 100);
	return { entries: page, next: matches.length > 100 ? (page.at(-1)?.id ?? null) : null };
}

/** Authors and timestamps come from the registered launch, never from caller-supplied JSON. */
export async function addDiary(value: unknown): Promise<DiaryEntry> {
	const data = diaryFields.parse(value);
	const author: DiaryEntry['author'] = { kind: 'operator', id: 'operator' };
	if (process.env.SUMMON_AGENT) {
		const id = currentAgent();
		if (
			!process.env.SUMMON_NONCE ||
			!(await loadAgent(id)) ||
			(await readActivity(id))?.nonce !== process.env.SUMMON_NONCE
		)
			throw new Error('Diary entries require the current registered launch.');
		author.kind = 'agent';
		author.id = id;
	}
	await validateDiaryReferences([data]);
	return communicationSend('save the Diary entry', () =>
		locked(`${diaryPath()}.lock`, async () => {
			const saved = await entries();
			const item: DiaryEntry = {
				...data,
				id: randomUUID(),
				at: new Date().toISOString(),
				author,
			};
			const raw = JSON.stringify({ version: 1, entries: [...saved, item] });
			if (Buffer.byteLength(raw) > DIARY_MAX_BYTES)
				throw new Error('Diary storage exceeds its safety limit.');
			await atomicWrite(diaryPath(), raw);
			return item;
		}),
	);
}
