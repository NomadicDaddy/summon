import { Team, type TerminalProcess } from '../../src/desktop/team.ts';

export function terminalHarness() {
	const inputs: string[] = [];
	const pty: TerminalProcess = {
		pid: process.pid,
		onData: () => ({ dispose: () => {} }),
		onExit: () => ({ dispose: () => {} }),
		write: (text) => inputs.push(String(text)),
		resize: () => {},
		kill: () => {},
	};
	const team = new Team(
		'bun',
		'cli.ts',
		() => {},
		() => pty,
	);
	return { team, inputs };
}
