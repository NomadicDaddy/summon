import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { localRoomPath } from '../src/local-room.ts';
import { runtimePath } from '../src/mail-session.ts';
import { currentRoomRequest } from '../src/room-current-request.ts';
import { localCursorPath } from '../src/room-cursor.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { notifyLocalRoom } from './fixtures/wake-notice.ts';

test('current human preview bypasses backlog without acknowledging history or receipts', async () => {
	const fixture = await mailHarness();
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = fixture.records;
	try {
		await mkdir(join(fixture.records, 'room'), { recursive: true });
		const events = Array.from({ length: 250 }, (_, index) => ({
			id: index + 1,
			at: new Date().toISOString(),
			sender: { kind: index === 248 ? 'user' : 'agent', id: 'operator' },
			text: index === 248 ? '@alpha new task' : 'Older traffic',
			replyTo: null,
			source: 'local',
		}));
		await writeFile(localRoomPath(), JSON.stringify(events));
		await mkdir(runtimePath('alpha'), { recursive: true });
		await writeFile(localCursorPath('alpha'), '1');
		const pending = join(runtimePath('alpha'), 'checkpoint.json');
		await writeFile(pending, 'pending receipt sentinel');
		const notices: string[] = [];
		await notifyLocalRoom('alpha', 'preview', (text) => {
			notices.push(text);
			return Promise.resolve();
		});
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain('summon --room read 248');
		expect(notices[0]).toContain('do not ack its cursor');
		expect(await readFile(localCursorPath('alpha'), 'utf8')).toBe('1');
		expect(await readFile(pending, 'utf8')).toBe('pending receipt sentinel');
		await writeFile(localCursorPath('alpha'), '249');
		expect(await currentRoomRequest('alpha')).toBe('');
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await fixture.dispose();
	}
});
