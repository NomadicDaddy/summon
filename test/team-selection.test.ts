import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';

import type { TeamEvent, TeamSnapshot } from '../src/desktop/types.ts';

import { Team } from '../src/desktop/team.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	mock.restore();
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

function harness(running: string[] = []) {
	const events: TeamEvent[] = [];
	const team = new Team(
		'bun',
		'cli.ts',
		(event) => events.push(event),
		() => {
			throw new Error('Unexpected provider launch');
		},
	);
	for (const slug of running)
		team.sessions.set(slug, {
			launch: { nonce: 'fixture', since: new Date().toISOString() },
			agent: {
				slug,
				name: slug,
				provider: 'codex',
				memberType: 'teammate',
				cwd: fixture.root,
				status: 'running',
			},
			pty: {
				pid: 1,
				onData: () => ({ dispose: () => {} }),
				onExit: () => ({ dispose: () => {} }),
				write: () => {},
				resize: () => {},
				kill: () => {},
			},
			previousActivityNonce: undefined,
			terminalNotices: false,
		});
	const snapshot = spyOn(team, 'snapshot').mockImplementation(() =>
		Promise.resolve({ agents: [], selected: team.selected }),
	);
	return {
		team,
		snapshot,
		selections: () =>
			events.flatMap((event) => (event.type === 'snapshot' ? [event.value.selected] : [])),
	};
}
function deferred() {
	let resolve: (value: TeamSnapshot) => void = () => {};
	const promise = new Promise<TeamSnapshot>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test('an older offline lookup cannot replace a newer running-member selection', async () => {
	const h = harness(['beta']);
	const older = h.team.select('alpha');
	await h.team.select('beta');
	await older;
	expect(h.team.selected).toBe('beta');
	expect(h.selections()).toEqual(['beta']);
});

test('two offline lookups still select the last requested member', async () => {
	const h = harness();
	await Promise.all([h.team.select('alpha'), h.team.select('beta')]);
	expect(h.team.selected).toBe('beta');
	expect(h.selections()).toEqual(['beta']);
});

test('an older completed snapshot cannot repaint a newer selection', async () => {
	const h = harness(['alpha', 'beta']);
	const gate = deferred();
	h.snapshot.mockImplementationOnce(() => gate.promise);
	const older = h.team.select('alpha');
	await h.team.select('beta');
	gate.resolve({ agents: [], selected: 'alpha' });
	await older;
	expect(h.team.selected).toBe('beta');
	expect(h.selections()).toEqual(['beta']);
});

test('same-member requests suppress an older pending snapshot too', async () => {
	const h = harness(['alpha']);
	const gate = deferred();
	h.snapshot.mockImplementationOnce(() => gate.promise);
	const older = h.team.select('alpha');
	await h.team.select('alpha');
	gate.resolve({ agents: [], selected: 'alpha' });
	await older;
	expect(h.selections()).toEqual(['alpha']);
});

test('a routine publish cannot restore a selection changed during its snapshot', async () => {
	const h = harness(['beta']);
	h.team.selected = 'alpha';
	const gate = deferred();
	h.snapshot.mockImplementationOnce(() => gate.promise);
	const refresh = h.team.publish();
	await h.team.select('beta');
	gate.resolve({ agents: [], selected: 'alpha' });
	await refresh;
	expect(h.selections()).toEqual(['beta']);
});

test('a normal refresh still publishes when selection is unchanged', async () => {
	const h = harness();
	h.team.selected = 'alpha';
	await h.team.publish();
	expect(h.selections()).toEqual(['alpha']);
});

test('a newer missing member cancels an older pending lookup without changing the prior selection', async () => {
	const h = harness(['beta']);
	h.team.selected = 'beta';
	const older = h.team.select('alpha');
	expect(await h.team.select('missing').catch((error: unknown) => String(error))).toContain(
		'Agent no longer exists.',
	);
	await older;
	expect(h.team.selected).toBe('beta');
	expect(h.selections()).toEqual([]);
});

test('a stale missing-member lookup cannot report an error after a valid newer choice', async () => {
	const h = harness(['beta']);
	const older = h.team.select('missing');
	await h.team.select('beta');
	expect(await older).toBeUndefined();
	expect(h.team.selected).toBe('beta');
	expect(h.selections()).toEqual(['beta']);
});
