import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { avatarFor, retainAvatars } from '../src/desktop/avatar.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

/*
 * avatarFor reuses a cached image while the file's dev, inode, size, mtime and ctime are unchanged.
 * A real replacement lands well after the last read, but these tests rewrite the same file within
 * milliseconds, often at the same size, and Windows then often leaves both times unchanged (401 of
 * 500 back-to-back rewrites measured): the cache would rightly answer from the earlier write. Each
 * write is therefore dated a step later than the one before, instead of trusting the clock to tick.
 */
let step = 0;
async function writeAvatar(path: string, data: Buffer | string): Promise<void> {
	await writeFile(path, data);
	step += 1;
	const later = new Date(Date.now() + step * 2000);
	await utimes(path, later, later);
}

test('avatars restrict paths, PNG headers, size and square dimensions; optional files fall back', async () => {
	const fixture = await mailHarness();
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = fixture.records;
	try {
		expect(await avatarFor('alpha')).toBeUndefined();
		const path = join(fixture.records, 'alpha.png');
		await writeAvatar(path, '<svg>not a PNG</svg>');
		expect(await avatarFor('alpha')).toBeUndefined();
		const header = Buffer.alloc(33);
		Buffer.from('89504e470d0a1a0a', 'hex').copy(header);
		header.writeUInt32BE(13, 8);
		header.write('IHDR', 12);
		header.writeUInt32BE(128, 16);
		header.writeUInt32BE(128, 20);
		await writeAvatar(path, header);
		// Decoder errors in otherwise plausible PNGs fall back in the renderer.
		expect(await avatarFor('alpha')).toStartWith('data:image/png;base64,');
		header.writeUInt32BE(513, 16);
		await writeAvatar(path, header);
		expect(await avatarFor('alpha')).toBeUndefined();
		header.writeUInt32BE(64, 16);
		await writeAvatar(path, header);
		expect(await avatarFor('alpha')).toBeUndefined();
		await writeAvatar(path, Buffer.alloc(262145));
		expect(await avatarFor('alpha')).toBeUndefined();
		expect(await avatarFor('../escape').catch((error: unknown) => String(error))).toContain(
			'Names may',
		);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await fixture.dispose();
	}
});

test('unchanged avatars avoid file reads; rewrites, deletion and roster removal invalidate', async () => {
	const fixture = await mailHarness();
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = fixture.records;
	const opened = spyOn(fs, 'open');
	try {
		const path = join(fixture.records, 'alpha.png');
		const bytes = Buffer.alloc(33);
		Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
		bytes.writeUInt32BE(13, 8);
		bytes.write('IHDR', 12);
		bytes.writeUInt32BE(128, 16);
		bytes.writeUInt32BE(128, 20);
		await writeAvatar(path, bytes);
		const first = await avatarFor('alpha');
		expect(first).toStartWith('data:image/png;base64,');
		const reads = opened.mock.calls.length;
		expect(await avatarFor('alpha')).toBe(first);
		expect(opened.mock.calls.length).toBe(reads);
		bytes[32] = 1;
		await writeAvatar(path, bytes);
		expect(await avatarFor('alpha')).not.toBe(first);
		expect(opened.mock.calls.length).toBe(reads + 1);
		retainAvatars([]);
		await avatarFor('alpha');
		expect(opened.mock.calls.length).toBe(reads + 2);
		await unlink(path);
		expect(await avatarFor('alpha')).toBeUndefined();
		await writeAvatar(path, 'invalid');
		expect(await avatarFor('alpha')).toBeUndefined();
	} finally {
		opened.mockRestore();
		retainAvatars([]);
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await fixture.dispose();
	}
});
