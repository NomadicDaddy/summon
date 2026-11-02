import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { readTeammateGallery } from '../src/teammate-gallery.ts';

let root: string;
const identity = {
	blurb: 'Builds things.',
	domain: 'Assigned application.',
	expertise: 'Engineering.',
	id: 'engineer',
	specialty: 'Engineer',
	suggestedName: 'Mira',
};
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-gallery-'));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

test('the packaged gallery supplies all thirteen identities without warnings', async () => {
	const result = await readTeammateGallery(resolve(import.meta.dir, '../gallery'));
	expect(result.warnings).toEqual([]);
	expect(result.templates.map((template) => template.id)).toEqual([
		'adhd-coach',
		'analyst',
		'architect',
		'engineer',
		'healthcare-advocate',
		'learning-coach',
		'records-organizer',
		'research-assistant',
		'reviewer',
		'security',
		'tester',
		'writer',
		'writing-partner',
	]);
});

test('the six non-engineering roles form a second row under Project manager', async () => {
	const [gallery, css] = await Promise.all([
		Bun.file(resolve(import.meta.dir, '../src/desktop/teammate-gallery.ts')).text(),
		Bun.file(resolve(import.meta.dir, '../src/desktop/maintenance.css')).text(),
	]);
	// Placement is decided by id in the renderer, so the files stay six fields and cannot set layout.
	expect(gallery.replaceAll(/\s+/gu, ' ')).toContain(
		"const secondRow = [ 'research-assistant', 'records-organizer', 'writing-partner', 'learning-coach', 'adhd-coach', 'healthcare-advocate', ];",
	);
	expect(gallery).toContain('place(blank, chips);');
	// Start blank alone in column one; both rows in column two, so row two starts under the PM chip.
	expect(css).toContain('grid-template-columns: max-content minmax(0, 1fr);');
	expect(css).toMatch(/\.maint-gallery-row \{\s*grid-column: 2;/u);
});

test('each new role states the boundary it keeps', async () => {
	const read = async (id: string): Promise<{ domain: string; expertise: string }> =>
		(await Bun.file(resolve(import.meta.dir, `../gallery/${id}.json`)).json()) as {
			domain: string;
			expertise: string;
		};
	const research = await read('research-assistant');
	const records = await read('records-organizer');
	const writing = await read('writing-partner');
	const learning = await read('learning-coach');
	const adhd = await read('adhd-coach');
	const advocate = await read('healthcare-advocate');
	expect(research.expertise).toContain('Never invents a source');
	expect(records.expertise).toContain('waits for approval before doing any of it');
	expect(writing.expertise).toContain('it never sends, posts or publishes anything');
	expect(learning.expertise).toContain('instead of inventing expertise');
	// A coach, not a clinician; and the advocate drafts but never makes contact itself (#6416).
	expect(adhd.expertise).toContain('does not diagnose, assess or treat ADHD');
	expect(adhd.expertise).toContain('gives no advice on medication');
	expect(advocate.expertise).toContain('never diagnoses');
	expect(advocate.expertise).toContain('never contacts a provider or insurer itself');
	expect(advocate.domain).toContain('and nothing outside it');
});

test('gallery edits are visible without rebuilding and preserve every identity field', async () => {
	await writeFile(join(root, 'engineer.json'), JSON.stringify(identity));
	expect(await readTeammateGallery(root)).toEqual({ templates: [identity], warnings: [] });
	const changed = { ...identity, suggestedName: 'New name' };
	await writeFile(join(root, 'engineer.json'), JSON.stringify(changed));
	expect((await readTeammateGallery(root)).templates).toEqual([changed]);
});

test('invalid entries produce warnings without removing valid choices', async () => {
	await writeFile(join(root, 'engineer.json'), JSON.stringify(identity));
	await writeFile(join(root, 'broken.json'), '{');
	await writeFile(join(root, 'mismatched.json'), JSON.stringify(identity));
	await writeFile(join(root, 'large.json'), 'x'.repeat(65537));
	await mkdir(join(root, 'directory.json'));
	await writeFile(join(root, 'script.json'), JSON.stringify({ ...identity, command: 'ignored' }));
	const result = await readTeammateGallery(root);
	expect(result.templates).toEqual([identity]);
	expect(result.warnings).toHaveLength(5);
	expect(result.warnings.join('\n')).toContain('broken.json');
});

test('missing and empty galleries remain readable with explicit diagnostics', async () => {
	expect(await readTeammateGallery(join(root, 'missing'))).toEqual({
		templates: [],
		warnings: ['Gallery directory is missing.'],
	});
	expect(await readTeammateGallery(root)).toEqual({
		templates: [],
		warnings: ['No gallery identities are available.'],
	});
});
