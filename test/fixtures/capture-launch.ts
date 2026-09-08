// Loaded only by CLI tests. Never launch an agent or a GUI from a test.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error('An isolated launch fixture is required.');
	return value;
}

const capturePath = requiredEnvironment('SUMMON_TEST_CAPTURE');
const codexRoot = requiredEnvironment('CODEX_HOME');

const realSpawn = Bun.spawn;
const allowed = new Set([
	'codex',
	'claude',
	'wt.exe',
	'osascript',
	'x-terminal-emulator',
	'gnome-terminal',
	'konsole',
]);

function captureLaunch(options: { cmd: string[]; cwd?: string }): ReturnType<typeof Bun.spawn> {
	const executable = options.cmd[0];
	if (!executable || !allowed.has(executable)) throw new Error('Unexpected test launch.');
	appendFileSync(capturePath, JSON.stringify({ cmd: options.cmd, cwd: options.cwd }) + '\n');
	if (process.env.SUMMON_TEST_SPAWN_ERROR === '1') throw new Error('Simulated launch failure.');
	if (executable === 'codex' && options.cmd[1] !== 'resume') {
		const sessions = join(codexRoot, 'sessions');
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, 'test-session.jsonl'),
			JSON.stringify({
				type: 'session_meta',
				payload: { id: 'test-codex-session', cwd: options.cwd },
			}) + '\n',
		);
	}
	return realSpawn({
		cmd: [
			process.execPath,
			'--eval',
			'process.exit(' + (process.env.SUMMON_TEST_EXIT ?? '0') + ')',
		],
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'ignore',
		windowsHide: true,
	});
}

// The fixture implements the object-form overload used by summon.
Bun.spawn = captureLaunch as typeof Bun.spawn;
const realWhich = Bun.which;
Bun.which = (command, options) =>
	command === 'x-terminal-emulator' ? '/test/x-terminal-emulator' : realWhich(command, options);
