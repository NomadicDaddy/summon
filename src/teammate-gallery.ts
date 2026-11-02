import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { GallerySnapshot, TeammateTemplate } from './teammate-templates.ts';

import { missing } from './mail-files.ts';

const fields = ['id', 'suggestedName', 'specialty', 'blurb', 'expertise', 'domain'] as const;
const maxBytes = 65536;

function validTemplate(value: unknown, id: string): value is TeammateTemplate {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		Object.keys(record).length === fields.length &&
		fields.every(
			(field) => typeof record[field] === 'string' && record[field].trim().length > 0,
		) &&
		record.id === id &&
		id !== 'start-blank'
	);
}

/** Read editable package content on demand; never accept a renderer-supplied filesystem path. */
export async function readTeammateGallery(directory: string): Promise<GallerySnapshot> {
	const result: GallerySnapshot = { templates: [], warnings: [] };
	try {
		const stat = await lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error('Gallery directory must be a regular directory.');
	} catch (error: unknown) {
		result.warnings.push(
			missing(error) ? 'Gallery directory is missing.' : 'Gallery directory cannot be read.',
		);
		return result;
	}
	let names: string[];
	try {
		names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
	} catch {
		result.warnings.push('Gallery directory cannot be read.');
		return result;
	}
	if (names.length > 100) result.warnings.push('Only the first 100 gallery files were read.');
	for (const name of names.slice(0, 100)) {
		try {
			if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(name)) throw new Error('Invalid name.');
			const path = join(directory, name);
			const stat = await lstat(path);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
				throw new Error('Invalid file.');
			const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const current = await file.stat();
				if (!current.isFile() || current.size > maxBytes) throw new Error('Invalid file.');
				const bytes = Buffer.alloc(maxBytes + 1);
				const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
				if (bytesRead > maxBytes) throw new Error('File too large.');
				const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
				if (!validTemplate(value, name.slice(0, -5))) throw new Error('Invalid template.');
				result.templates.push(value);
			} finally {
				await file.close();
			}
		} catch {
			result.warnings.push(`Skipped invalid or unreadable gallery file: ${name}`);
		}
	}
	if (result.templates.length === 0) result.warnings.push('No gallery identities are available.');
	return result;
}
