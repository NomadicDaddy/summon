import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';

import { missing } from './mail-files.ts';

const allowed = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD']);

async function packageFor(
	input: string,
): Promise<{ root: string; manifest: Record<string, unknown> }> {
	let root = dirname(input);
	while (root !== parse(root).root) {
		try {
			const value: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
			if (typeof value === 'object' && value !== null && 'name' in value && value.name) {
				return { root, manifest: value };
			}
		} catch (error: unknown) {
			if (!missing(error)) throw error;
		}
		root = dirname(root);
	}
	throw new Error(`No package manifest for bundled input: ${input}`);
}

export async function thirdPartyNotices(inputs: readonly string[]): Promise<string> {
	const packages = new Map<string, string>();
	const seen = new Set<string>();
	for (const input of inputs) {
		const { root, manifest } = await packageFor(input);
		if (seen.has(root)) continue;
		seen.add(root);
		const { name, version, license } = manifest;
		if (
			typeof name !== 'string' ||
			typeof version !== 'string' ||
			typeof license !== 'string' ||
			!allowed.has(license)
		) {
			throw new Error(`Missing or unreviewed bundled package license: ${root}`);
		}
		const files = (await readdir(root))
			.filter((file) => /^(?:licen[cs]e|copying|notice)(?:\.[^.]+)?$/i.test(file))
			.sort();
		if (!files.some((file) => /^(?:licen[cs]e|copying)(?:\.|$)/i.test(file)))
			throw new Error(`No packaged license text: ${name}@${version}`);
		const texts: string[] = [];
		for (const file of files) {
			const text = (await readFile(join(root, file), 'utf8')).replaceAll('\r\n', '\n').trim();
			if (!text) throw new Error(`Empty license or notice: ${name}/${file}`);
			texts.push(`### ${file}\n\n\`\`\`text\n${text}\n\`\`\``);
		}
		const key = `${name}@${version}`;
		const section = `## ${key}\n\nSPDX: ${license}\n\n${texts.join('\n\n')}`;
		if (packages.has(key) && packages.get(key) !== section)
			throw new Error(`Conflicting license texts for ${key}`);
		packages.set(key, section);
	}
	return (
		'# Third-party notices\n\n' +
		'Generated from the packages included in the Team Window bundles and stylesheet.\n' +
		'Run `bun scripts/generate-third-party-notices.ts --write` after building to refresh.\n\n' +
		[...packages]
			.sort(([left], [right]) => left.localeCompare(right, 'en'))
			.map(([, section]) => section)
			.join('\n\n') +
		'\n'
	);
}

export function assertNoticesCurrent(actual: string, expected: string): void {
	if (actual.replaceAll('\r\n', '\n') !== expected)
		throw new Error('THIRD-PARTY-NOTICES.md is stale; regenerate and review it.');
}
