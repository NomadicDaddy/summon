import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import { sendHuman } from '../src/local-room-access.ts';
import { localPage } from '../src/local-room.ts';
import { roomImageData, roomImagePath, saveRoomImage } from '../src/room-image.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

test('room image-only messages persist without bloating pages and reject path traversal', async () => {
	const fixture = await mailHarness();
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = fixture.records;
	try {
		const png = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGL5//8/AAAA//+rxzhLAAAABklEQVQDAAYOAwJctCtXAAAAAElFTkSuQmCC',
			'base64',
		);
		const id = await saveRoomImage(png);
		expect(await saveRoomImage(png)).toBe(id);
		const event = await sendHuman('', null, id);
		expect(event.image).toBe(id);
		expect((await localPage(0)).events[0]?.image).toBe(id);
		expect(await readFile(roomImagePath(id))).toEqual(png);
		expect(await roomImageData(id)).toBe(`data:image/png;base64,${png.toString('base64')}`);
		expect(() => roomImagePath('../secret')).toThrow('Invalid room image');
		expect(
			await sendHuman('', null, '../secret').catch((error: unknown) => error),
		).toBeInstanceOf(Error);
		expect((await localPage(0)).events).toHaveLength(1);
		const read = await fixture.run(['--room', 'read'], 'alpha');
		expect(read.code).toBe(0);
		const page = JSON.parse(read.out) as { events: { imagePath: string }[] };
		expect(page.events[0]?.imagePath).toBe(roomImagePath(id));
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await fixture.dispose();
	}
});
