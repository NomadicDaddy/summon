import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { teamSnapshot } from '../src/desktop/team-snapshot.ts';
import { appendLocalEvent, localRoomPath } from '../src/local-room.ts';
import { localCursorPath } from '../src/room-cursor.ts';
import { roomProgress } from '../src/room-progress.ts';
import { newRecord, saveAgent } from '../src/store.ts';

test('room progress measures acknowledged history without changing it', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-room-progress-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		// Registered first: a new member's cursor starts at the present, here the empty Room.
		await saveAgent('reader', newRecord('reader', root, 'codex'));
		expect(await roomProgress('reader')).toEqual({ cursor: 0, head: 0, pending: 0 });
		for (const text of ['First', 'Second', 'Third'])
			await appendLocalEvent({
				sender: { kind: 'user', id: 'operator' },
				text,
				replyTo: null,
				source: 'local',
			});
		expect(await roomProgress('reader')).toEqual({ cursor: 0, head: 3, pending: 3 });
		const cursor = localCursorPath('reader');
		await mkdir(dirname(cursor), { recursive: true });
		await writeFile(cursor, '1');
		expect(await roomProgress('reader')).toEqual({ cursor: 1, head: 3, pending: 2 });
		expect(await readFile(cursor, 'utf8')).toBe('1');
		const context = {
			sessions: new Map(),
			reported: new Set<string>(),
			emit: () => {},
			startedAt: new Date().toISOString(),
			selected: '',
		};
		expect((await teamSnapshot(context)).agents[0]?.roomProgress).toEqual({
			cursor: 1,
			head: 3,
			pending: 2,
		});
		await writeFile(cursor, '3');
		expect(await roomProgress('reader')).toEqual({ cursor: 3, head: 3, pending: 0 });
		for (const invalid of ['4', '-1', 'bad', '9007199254740992']) {
			await writeFile(cursor, invalid);
			expect(await roomProgress('reader')).toBeUndefined();
		}
		await writeFile(cursor, '0');
		await writeFile(localRoomPath(), 'broken history');
		expect(await roomProgress('reader')).toBeUndefined();
		const unavailable = (await teamSnapshot(context)).agents;
		expect(unavailable).toHaveLength(1);
		expect(unavailable[0]?.roomProgress).toBeUndefined();
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
});
