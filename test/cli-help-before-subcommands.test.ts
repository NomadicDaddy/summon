import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		const target = resolve(root);
		if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('summon-help-'))
			throw new Error('Refusing to remove an unexpected test directory.');
		await rm(target, { recursive: true, force: true });
	}
});

async function run(root: string, args: string[]): Promise<{ code: number; stdout: string }> {
	const child = Bun.spawn({
		cmd: [process.execPath, resolve(import.meta.dir, '../src/cli.ts'), ...args],
		env: { ...process.env, SUMMON_HOME: root, SUMMON_NONCE: '', SUMMON_AGENT: '' },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'ignore',
		windowsHide: true,
	});
	const stdout = await new Response(child.stdout).text();
	return { code: await child.exited, stdout };
}

/** Every file under the store with its content hash, so any write shows up as a difference. */
async function snapshot(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		files[path.slice(root.length)] = createHash('sha256')
			.update(await readFile(path))
			.digest('hex');
	}
	return files;
}

const writing = [
	['--room', 'ask', '--help'],
	['--room', 'send', '--help'],
	['--room', 'send', '--to-user', '--help'],
	['--room', 'reply', '1', '--help'],
	['--msg', '--help'],
	['--mail', 'send-self', 'someone', '--help'],
	['--status', 'busy', '-h'],
	['--diary', 'add', '--help'],
	['--hibernate', '--help'],
	['--board', 'create', '--help'],
];

test.each(writing.map((args) => [args.join(' '), args] as const))(
	'summon %s prints help and writes nothing',
	async (_label, args) => {
		const root = join(await mkdtemp(join(tmpdir(), 'summon-help-')), 'home');
		roots.push(dirname(root));
		// The first help run initializes the store, as plain `summon --help` always has.
		expect((await run(root, ['--help'])).code).toBe(0);
		const before = await snapshot(root);
		const result = await run(root, args);
		expect(result.code).toBe(0);
		expect(result.stdout.startsWith('summon <name> [options]')).toBe(true);
		expect(await snapshot(root)).toEqual(before);
	},
);
