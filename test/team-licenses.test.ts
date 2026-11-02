import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertNoticesCurrent, thirdPartyNotices } from '../src/team-licenses.ts';

test('bundled notices retain full texts, find named roots and reject missing or unknown licenses', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-licenses-'));
	try {
		const pkg = join(root, 'node_modules', 'fixture');
		const nested = join(pkg, 'dist');
		await mkdir(nested, { recursive: true });
		await writeFile(join(nested, 'package.json'), '{"type":"module"}');
		const manifest = join(pkg, 'package.json');
		await writeFile(
			manifest,
			JSON.stringify({ name: 'fixture', version: '1.0.0', license: 'MIT' }),
		);
		await writeFile(join(pkg, 'LICENSE'), 'Copyright fixture\nPermission is hereby granted.\n');
		await writeFile(join(pkg, 'NOTICE'), 'Additional attribution\n');
		const inputs = [join(nested, 'index.js'), join(nested, 'other.js')];
		const text = await thirdPartyNotices(inputs);
		expect(text.match(/## fixture@1.0.0/g)).toHaveLength(1);
		expect(text).toContain('Copyright fixture\nPermission is hereby granted.');
		expect(text).toContain('Additional attribution');
		expect(() => assertNoticesCurrent(text, text)).not.toThrow();
		expect(() => assertNoticesCurrent(text.split('## fixture')[0] ?? '', text)).toThrow(
			'stale',
		);
		await writeFile(
			manifest,
			JSON.stringify({ name: 'fixture', version: '1.0.0', license: 'GPL-3.0' }),
		);
		expect(thirdPartyNotices(inputs)).rejects.toThrow('unreviewed');
		await writeFile(manifest, JSON.stringify({ name: 'fixture', version: '1.0.0' }));
		expect(thirdPartyNotices(inputs)).rejects.toThrow('unreviewed');
		await writeFile(
			manifest,
			JSON.stringify({ name: 'fixture', version: '1.0.0', license: 'MIT' }),
		);
		await rm(join(pkg, 'LICENSE'));
		expect(thirdPartyNotices(inputs)).rejects.toThrow('No packaged license');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
