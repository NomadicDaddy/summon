import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TeamAgent, TeamSnapshot } from '../src/desktop/types.ts';

import { initializeActivity } from '../src/agent-activity.ts';
import * as identity from '../src/checkpoint-offline-runtime.ts';
import { publishLaunchStatus, readLaunchStatus } from '../src/launch-status.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { terminalHarness } from './fixtures/owned-terminal.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = { home: process.env.SUMMON_HOME, agent: process.env.SUMMON_AGENT };
const stamp = new Date().toISOString();
const sampledAt = Date.parse(stamp);
const agent = (overrides: Partial<TeamAgent> = {}): TeamAgent => ({
	slug: 'alpha',
	name: 'Alpha',
	provider: 'claude',
	cwd: '/private-work',
	status: 'running',
	ownedSession: true,
	workingOn: 'PRIVATE_TASK',
	expertise: 'PRIVATE_EXPERTISE',
	domain: 'PRIVATE_DOMAIN',
	coveredBy: '',
	activity: 'idle',
	unreadMail: 7,
	canManageHeadDown: false,
	memberType: 'teammate',
	launch: { phase: 'connecting', since: stamp, evidence: 'owned-process-spawn' },
	...overrides,
});
const frame = (agents: TeamAgent[]): TeamSnapshot => ({
	startedAt: stamp,
	selected: 'alpha',
	agents,
});
const path = () => join(fixture.records, 'runtime/team-window/launch-status.json');
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous.home;
	if (previous.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previous.agent;
	await fixture.dispose();
});
const publish = (
	agents: TeamAgent[],
	now = sampledAt,
	reports = new Set<string>(),
	errors: string[] = [],
) =>
	publishLaunchStatus(
		frame(agents),
		now,
		reports,
		(message) => {
			errors.push(message);
		},
		agents.filter((row) => row.ownedSession && row.status === 'running').map((row) => row.slug),
	);

test('public phases cover all four providers and omit completed, external and dormant rows', async () => {
	const rows = (['claude', 'codex', 'grok', 'kilo'] as const).map((provider) =>
		agent({ slug: provider, provider }),
	);
	const done = agent();
	delete done.launch;
	await publish([
		...rows,
		done,
		agent({ status: 'elsewhere' }),
		agent({ ownedSession: false }),
		agent({ status: 'hibernated' }),
		agent({ status: 'exited' }),
		agent({ status: 'stopped' }),
	]);
	const control = spyOn(identity, 'processStart').mockResolvedValue(sampledAt - 1000);
	try {
		const view = await readLaunchStatus(sampledAt + 1);
		expect(view.current).toBe(true);
		expect(view.members.map((member) => member.provider)).toEqual([
			'claude',
			'codex',
			'grok',
			'kilo',
		]);
		for (const secret of [
			'PRIVATE_TASK',
			'PRIVATE_EXPERTISE',
			'PRIVATE_DOMAIN',
			'private-work',
			'pid',
			'nonce',
			'sessionId',
		])
			expect(JSON.stringify(view)).not.toContain(secret);
		expect(Object.keys(view.members[0] ?? {}).sort()).toEqual(['launch', 'provider', 'slug']);
	} finally {
		control.mockRestore();
	}
});

test('stale, future, absent and unverifiable owners never turn into a current empty roster', async () => {
	await publish([agent()]);
	const control = spyOn(identity, 'processStart');
	try {
		for (const started of [undefined, 'absent' as const, sampledAt + 1]) {
			control.mockResolvedValue(started);
			expect((await readLaunchStatus(sampledAt + 2)).current).toBe(false);
		}
		control.mockResolvedValue(sampledAt - 1);
		expect((await readLaunchStatus(sampledAt + 10001)).current).toBe(false);
		expect((await readLaunchStatus(sampledAt - 1)).current).toBe(false);
		await publish([]);
		expect(await readLaunchStatus(sampledAt + 1)).toMatchObject({ current: true, members: [] });
	} finally {
		control.mockRestore();
	}
});

test('invalid snapshots recover on the next publication and older overlapping polls cannot replace newer ones', async () => {
	await publish([agent()]);
	await writeFile(path(), '{');
	expect((await readLaunchStatus(sampledAt)).current).toBe(false);
	await publish([agent({ slug: 'with.dots_and-dashes' })], sampledAt + 10);
	const newer = await readFile(path(), 'utf8');
	await publish([agent({ slug: 'old-row' })], sampledAt);
	expect(await readFile(path(), 'utf8')).toBe(newer);
});

test('evidence that expires during process verification is unavailable', async () => {
	await publish([agent()]);
	const control = spyOn(identity, 'processStart').mockImplementation(async () => {
		await Bun.sleep(20);
		return sampledAt - 1;
	});
	try {
		expect((await readLaunchStatus(sampledAt + 9990)).current).toBe(false);
	} finally {
		control.mockRestore();
	}
});

test('oversized and invalid UTF-8 snapshots are unavailable and recover without an unbounded read', async () => {
	await publish([agent()]);
	for (const bytes of [Buffer.alloc(256 * 1024 + 1), Buffer.from([0xff])]) {
		await writeFile(path(), bytes);
		expect((await readLaunchStatus(sampledAt)).current).toBe(false);
		await publish([agent()]);
		expect(JSON.parse(await readFile(path(), 'utf8')) as unknown).toMatchObject({ version: 1 });
	}
});

test('failed publication keeps display available, reports once, and clears after recovery', async () => {
	const errors: string[] = [],
		reports = new Set<string>();
	await mkdir(join(fixture.records, 'runtime/team-window'), { recursive: true });
	await mkdir(path());
	await publish([agent()], sampledAt, reports, errors);
	await publish([agent()], sampledAt, reports, errors);
	expect(errors).toHaveLength(1);
	await rmdir(path());
	await publish([agent()], sampledAt, reports, errors);
	expect(reports.size).toBe(0);
	const text = await readFile(path(), 'utf8');
	process.env.SUMMON_AGENT = 'alpha';
	await publish([agent()], sampledAt + 5, reports, errors);
	expect(await readFile(path(), 'utf8')).toBe(text);
	expect(errors).toHaveLength(2);
});

test('owned Team snapshot publishes the phases through the real main-side consumer', async () => {
	const h = terminalHarness();
	await h.team.start('alpha', false);
	const launch = h.team.sessions.get('alpha')?.launch;
	if (!launch) throw new Error('Missing launch.');
	await initializeActivity('alpha', launch.nonce, 'claude');
	await h.team.snapshot();
	expect(await Bun.file(path()).json()).toMatchObject({
		members: [{ slug: 'alpha', launch: { phase: 'connecting' } }],
	});
});

test('CLI is read-only before initialization and refuses extra arguments', async () => {
	await publish([agent()]);
	const before = await readFile(path(), 'utf8');
	await writeFile(join(fixture.records, 'team-rules.md'), 'INVALID_RULES_SENTINEL');
	const result = await fixture.run(['--launch-status'], 'alpha');
	expect(result.code).toBe(0);
	expect(result.error).toBe('');
	expect(await readFile(path(), 'utf8')).toBe(before);
	expect(await readFile(join(fixture.records, 'team-rules.md'), 'utf8')).toBe(
		'INVALID_RULES_SENTINEL',
	);
	expect((await fixture.run(['--launch-status', 'extra'], 'alpha')).code).toBe(1);
});

test.skipIf(process.platform !== 'win32')(
	'Windows public CLI validates its real publishing process identity',
	async () => {
		const now = Date.now();
		const value = frame([agent()]);
		value.startedAt = new Date(now).toISOString();
		const first = value.agents[0];
		if (!first?.launch) throw new Error('Missing launch fixture.');
		first.launch.since = value.startedAt;
		await publishLaunchStatus(value, now, new Set(), () => {}, ['alpha']);
		// Launch-capture fixtures intentionally intercept PowerShell. This read-only route
		// needs the native CIM query to establish a real, current process as its control.
		const child = Bun.spawn({
			cmd: [process.execPath, join(import.meta.dir, '../src/cli.ts'), '--launch-status'],
			cwd: fixture.root,
			env: { ...process.env, SUMMON_HOME: fixture.records, SUMMON_AGENT: 'alpha' },
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		});
		const [out, error, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code).toBe(0);
		expect(error).toBe('');
		const parsed: unknown = JSON.parse(out);
		expect(parsed).toMatchObject({
			current: true,
			members: [{ slug: 'alpha', provider: 'claude' }],
		});
	},
);
