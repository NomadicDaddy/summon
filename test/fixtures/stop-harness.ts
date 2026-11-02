import type { TeamEvent } from '../../src/desktop/types.ts';

import { initializeActivity } from '../../src/agent-activity.ts';
import { initializeClaudeTurn, observeClaudeTurn } from '../../src/claude-turn-state.ts';
import { Team, type TerminalProcess } from '../../src/desktop/team.ts';

/** A started Claude session, a roster row taken while it was idle, and a way to begin a turn. */
export async function idleThenBusy() {
	const h = stopHarness();
	await h.team.start('alpha');
	const nonce = h.team.sessions.get('alpha')?.launch.nonce;
	if (!nonce) throw new Error('Missing launch.');
	await initializeActivity('alpha', nonce, 'claude');
	await initializeClaudeTurn('alpha', nonce, 'thread', 'observer');
	let sequence = 0;
	const event = (kind: 'attach' | 'idle' | 'start') =>
		observeClaudeTurn('alpha', nonce, 'observer', {
			session: 'thread',
			epoch: 1,
			sequence: ++sequence,
			kind,
			turn: kind === 'start' ? 'turn-1' : null,
			draft: false,
			completed: false,
		});
	await event('attach');
	await event('idle');
	const stale = (await h.team.snapshot()).agents.find((agent) => agent.slug === 'alpha');
	if (!stale) throw new Error('Missing alpha.');
	return { h, nonce, stale, beginTurn: () => event('start') };
}

/** A Team with one fixture process per launch, so a stop can only reach the process it names. */
export function stopHarness(
	beforeTerminate: (pid: number) => Promise<void> = () => Promise.resolve(),
) {
	const events: TeamEvent[] = [];
	const exits = new Map<number, (event: { exitCode: number }) => void>();
	const terminated: number[] = [];
	let nextPid = 100;
	const team = new Team(
		'bun',
		'cli.ts',
		(event) => {
			events.push(event);
		},
		() => {
			const pid = nextPid++;
			const pty: TerminalProcess = {
				pid,
				onData: () => ({ dispose: () => {} }),
				onExit: (listener) => {
					exits.set(pid, listener);
					return { dispose: () => {} };
				},
				write: () => {},
				resize: () => {},
				kill: () => exits.get(pid)?.({ exitCode: 0 }),
			};
			return pty;
		},
		async (pid) => {
			terminated.push(pid);
			await beforeTerminate(pid);
			exits.get(pid)?.({ exitCode: 0 });
		},
	);
	return { team, events, terminated };
}
