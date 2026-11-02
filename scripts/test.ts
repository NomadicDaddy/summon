import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fixture hooks must not leak between files or restore the invoking team's live store.
export {};
const root = await mkdtemp(join(tmpdir(), 'summon-test-run-'));
const env = { ...process.env };
env.SUMMON_HOME = root;
delete env.SUMMON_AGENT;
delete env.SUMMON_NONCE;
delete env.SUMMON_TEAMS_HOME;
// Room notices are debounced until the room falls quiet. Delivery tests assert that a notice
// arrives and what it says, not when, so they run with the window collapsed rather than each
// sleeping through a real one. The debounce's own timing is asserted with explicit windows.
env.SUMMON_ROOM_WAKE_QUIET_MS = '0';
// Windows integration cases start several CLIs or PowerShell workers. Keep their outer
// harness budget bounded without changing explicit test deadlines or product timeouts.
// Caller-supplied --timeout still overrides this default; file execution stays serial.
const timeout = process.platform === 'win32' ? ['--timeout', '15000'] : [];
const child = Bun.spawn(
	[process.execPath, 'test', ...timeout, ...process.argv.slice(2), '--isolate'],
	{
		env,
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
	},
);
try {
	process.exitCode = await child.exited;
} finally {
	await rm(root, { recursive: true, force: true });
}
