import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { galleryAvatar, installGalleryAvatar } from '../src/gallery-avatar.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

test('gallery icon IDs are bounded, creation-only and copied without overwriting custom files', async () => {
	const fixture = await mailHarness();
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = fixture.records;
	try {
		const gallery = join(fixture.records, 'gallery');
		await mkdir(gallery);
		const profile = { galleryId: 'project-manager', memberType: 'pm' };
		const header = Buffer.alloc(33);
		Buffer.from('89504e470d0a1a0a', 'hex').copy(header);
		header.writeUInt32BE(13, 8);
		header.write('IHDR', 12);
		header.writeUInt32BE(128, 16);
		header.writeUInt32BE(128, 20);
		const source = join(gallery, 'project-manager.png');
		await writeFile(source, header);
		expect(await galleryAvatar(gallery, profile, null)).toEqual(header);
		await installGalleryAvatar('new-manager', header);
		const destination = join(fixture.records, 'new-manager.png');
		expect(await readFile(destination)).toEqual(header);
		await writeFile(destination, 'custom avatar');
		await installGalleryAvatar('new-manager', header);
		expect(await readFile(destination, 'utf8')).toBe('custom avatar');
		expect(galleryAvatar(gallery, profile, 'new-manager')).rejects.toThrow('only');
		expect(galleryAvatar(gallery, { galleryId: '../escape' }, null)).rejects.toThrow('Invalid');
		expect(galleryAvatar(gallery, { galleryId: 'unknown' }, null)).rejects.toThrow('no longer');
		expect(
			galleryAvatar(gallery, { ...profile, memberType: 'teammate' }, null),
		).rejects.toThrow('member type');
		header.writeUInt32BE(129, 20);
		await writeFile(source, header);
		expect(await galleryAvatar(gallery, profile, null)).toBeUndefined();
		await writeFile(source, Buffer.alloc(262145));
		expect(await galleryAvatar(gallery, profile, null)).toBeUndefined();
		expect(await galleryAvatar(gallery, {}, null)).toBeUndefined();
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await fixture.dispose();
	}
});
