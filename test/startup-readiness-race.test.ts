import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cliHarness } from './fixtures/cli-harness.ts';

// startup-readiness-command spec 2 (Roger #19256): a relaunch racing a live launch must leave one
// identity. The prompt, the activity record and the only spawned provider's SUMMON_NONCE all name
// the live launch, and the racing launch's nonce is never published or accepted.
let fixture: Awaited<ReturnType<typeof cliHarness>>;
const children: ReturnType<typeof Bun.spawn>[] = [];
beforeEach(async () => {
	fixture = await cliHarness();
});
afterEach(async () => {
	await writeFile(join(fixture.root, 'release-provider'), 'release');
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill();
		await child.exited;
	}
	await fixture.dispose();
});

const runtime = () => join(fixture.records, 'runtime/member');
const capture = () => join(fixture.root, 'race-launches.jsonl');

function session(nonce: string, release?: string) {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			'--preload',
			join(import.meta.dir, 'fixtures/capture-launch.ts'),
			join(import.meta.dir, '../src/cli.ts'),
			'__session',
			'member',
			'--storage-root',
			fixture.records,
			'--launch-nonce',
			nonce,
		],
		cwd: fixture.project,
		env: {
			...process.env,
			SUMMON_AGENT: '',
			AIDD_AGENT: '',
			SUMMON_HOME: fixture.records,
			SUMMON_TEAMS_HOME: fixture.teams,
			CODEX_HOME: join(fixture.root, 'codex'),
			GROK_HOME: join(fixture.root, 'grok'),
			SUMMON_TEST_CAPTURE: capture(),
			SUMMON_TEST_EXIT: '0',
			SUMMON_TEST_CODEX_NO_BINDING: '1',
			...(release ? { SUMMON_TEST_RELEASE: release } : {}),
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	children.push(child);
	return child;
}

const finish = async (child: ReturnType<typeof session>) => ({
	code: await child.exited,
	stdout: await new Response(child.stdout as ReadableStream).text(),
});

test('a relaunch racing a live launch publishes nothing; prompt, activity and child agree', async () => {
	await fixture.seed('codex');
	await writeFile(capture(), '');
	const live = randomUUID();
	const racing = randomUUID();
	const release = join(fixture.root, 'release-provider');
	const first = session(live, release);
	for (let attempt = 0; attempt < 400; attempt++) {
		if ((await readFile(capture(), 'utf8')).trim()) break;
		await Bun.sleep(25);
	}
	// Say so plainly if the live launch never reached its provider, rather than racing nothing.
	expect((await readFile(capture(), 'utf8')).trim()).not.toBe('');
	const second = await finish(session(racing));
	expect(second.code).toBe(0);
	expect(second.stdout).toContain('already running');

	const prompt = await readFile(join(runtime(), 'session-prompt.md'), 'utf8');
	expect(prompt).toContain(`This launch's readiness command: summon --mail ready ${live}\n`);
	expect(prompt).not.toContain(racing);
	const activity = JSON.parse(await readFile(join(runtime(), 'activity.json'), 'utf8')) as {
		nonce: string;
	};
	expect(activity.nonce).toBe(live);
	const spawned = (await readFile(capture(), 'utf8'))
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as { cmd: string[]; summonNonce?: string });
	expect(spawned.map((entry) => entry.summonNonce)).toEqual([live]);
	// Readiness notices are keyed to the child's own SUMMON_NONCE (prepareReadiness), so with only
	// the live child spawned there is no source for a notice naming the racing nonce. Delivering
	// an actual notice to this child isn't exercised here.

	// The racing launch's command is refused from the live session and leaves no ready file.
	const stale = await fixture.invoke(['--mail', 'ready', racing], {
		SUMMON_AGENT: 'member',
		SUMMON_NONCE: live,
	});
	expect(stale.code).toBe(1);
	expect(stale.stderr).toContain('Readiness nonce does not match this session.');
	expect(await Bun.file(join(runtime(), `${racing}.ready`)).exists()).toBe(false);
	expect(
		(JSON.parse(await readFile(join(runtime(), 'activity.json'), 'utf8')) as { nonce: string })
			.nonce,
	).toBe(live);

	await writeFile(release, 'release');
	expect((await finish(first)).code).toBe(0);
}, 60_000);
