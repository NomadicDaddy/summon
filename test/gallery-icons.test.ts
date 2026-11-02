import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/*
 * Every starter in the Add teammate gallery carries an icon that a new member created from it takes
 * as its avatar (#5604/#5606). The avatar loader silently falls back to initials for anything that
 * is not a real square PNG between 32 and 512 px and at most 256 KiB, so a bad file would not fail
 * loudly anywhere; this is where it fails.
 */
const root = resolve(import.meta.dir, '..');
const BUILT_IN = ['project-manager'];

async function starterIds(): Promise<string[]> {
	const files = await readdir(resolve(root, 'gallery'));
	return [
		...BUILT_IN,
		...files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5)),
	];
}

test('every starter ships a 128x128 RGBA PNG within the avatar limits', async () => {
	const ids = await starterIds();
	expect(ids).toHaveLength(14);
	for (const id of ids) {
		const bytes = new Uint8Array(
			await Bun.file(resolve(root, 'gallery', `${id}.png`)).arrayBuffer(),
		);
		const view = new DataView(bytes.buffer);
		expect([...bytes.slice(0, 8)], id).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		expect(String.fromCharCode(...bytes.slice(12, 16)), id).toBe('IHDR');
		expect([view.getUint32(16), view.getUint32(20)], id).toEqual([128, 128]);
		expect(bytes[25], `${id} colour type`).toBe(6);
		expect(bytes.length, id).toBeLessThanOrEqual(262144);
	}
});

test('every icon keeps its SVG source, and nothing else is in the gallery folder', async () => {
	const ids = await starterIds();
	const sources = (await readdir(resolve(root, 'gallery-src'))).filter((file) =>
		file.endsWith('.svg'),
	);
	expect(sources.map((file) => file.slice(0, -4)).sort()).toEqual([...ids].sort());
	const gallery = await readdir(resolve(root, 'gallery'));
	expect(gallery.filter((file) => !/\.(json|png)$/u.test(file))).toEqual([]);
});

test('a new member is sent its starter id; Start blank and edits are not', async () => {
	const maintenance = await Bun.file(resolve(root, 'src/desktop/maintenance.ts')).text();
	expect(maintenance).toContain("existing === null && gallery.chosen() !== 'start-blank'");
	expect(maintenance).toContain('{ galleryId: gallery.chosen() }');
});
