// Loaded only by CLI tests. Never launch an agent or a GUI from a test.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error('An isolated launch fixture is required.');
	return value;
}

const capturePath = requiredEnvironment('SUMMON_TEST_CAPTURE');
const codexRoot = requiredEnvironment('CODEX_HOME');

const realSpawn = Bun.spawn;
if (process.env.SUMMON_TEST_CLAUDE_BRIDGE_FAILURE === '1')
	Bun.serve = () => {
		throw new Error('Simulated native observation failure.');
	};
const allowed = new Set([
	'codex',
	'claude',
	'grok',
	'kilo',
	'wt.exe',
	'osascript',
	'x-terminal-emulator',
	'gnome-terminal',
	'konsole',
	'pwsh',
]);

// Actual absolute PATH entries are now part of the launch contract. Dummy files are
// intercepted below before execution; installed real providers are never fixture targets.
const bin = join(dirname(capturePath), 'fixture-bin');
mkdirSync(bin, { recursive: true });
for (const name of allowed) {
	if (name === 'pwsh') continue;
	if (
		process.env.SUMMON_TEST_NO_TERMINAL === '1' &&
		!['codex', 'claude', 'grok', 'kilo'].includes(name)
	)
		continue;
	writeFileSync(
		join(bin, process.platform === 'win32' && !name.endsWith('.exe') ? `${name}.exe` : name),
		'',
		{ mode: 0o700 },
	);
}
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;

function captureLaunch(options: {
	cmd: string[];
	cwd?: string;
	detached?: boolean;
	env?: Record<string, string | undefined>;
}): ReturnType<typeof Bun.spawn> {
	const selected = options.cmd[0];
	const executable = selected?.startsWith(bin)
		? basename(selected)
				.replace(/\.exe$/i, '')
				.replace(/^wt$/, 'wt.exe')
		: selected;
	// Permit only the read-only PID start-time query, not arbitrary PowerShell launches.
	if (
		selected &&
		basename(selected).toLowerCase() === 'pwsh.exe' &&
		options.cmd[1] === '-NoProfile' &&
		options.cmd[2] === '-NonInteractive' &&
		options.cmd[3] === '-Command' &&
		/^\$p = Get-Process -Id \d+ -ErrorAction Stop; \(\[DateTimeOffset\]\$p\.StartTime\.ToUniversalTime\(\)\)\.ToUnixTimeMilliseconds\(\)$/.test(
			options.cmd[4] ?? '',
		)
	)
		return realSpawn(options);
	// The operator start's scratch expiry worker runs for real against the fixture store.
	if (
		selected === 'pwsh' &&
		options.cmd.slice(1, 5).join(' ') === '-NoLogo -NoProfile -NonInteractive -File' &&
		options.cmd[5] === join(import.meta.dir, '..', '..', 'scripts', 'scratch-expiry.ps1') &&
		options.cmd.length === 6
	)
		return realSpawn(options);
	// Node's execFile uses Bun.spawn too. Existing launch scenarios model a normal
	// token regardless of the test host. high-integrity.ts covers refusal separately.
	if (
		executable?.toLowerCase() ===
		join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe').toLowerCase()
	)
		return realSpawn({
			...options,
			cmd: [process.execPath, '-e', 'console.log("S-1-16-8192")'],
		});
	if (
		!executable ||
		(!allowed.has(executable) && basename(executable).toLowerCase() !== 'electron.exe')
	)
		throw new Error('Unexpected test launch.');
	if (executable === 'kilo' && options.cmd[1] === 'acp') {
		if (process.env.SUMMON_TEST_EDIT_DURING_ALLOCATION === '1') {
			const path = join(requiredEnvironment('SUMMON_HOME'), 'member.json');
			const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
			record.domain = 'Operator changed domain during allocation';
			record.expertise = 'Operator changed expertise during allocation';
			writeFileSync(path, JSON.stringify(record));
		}
		return realSpawn({
			cmd: [
				process.execPath,
				'-e',
				`import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,
 result:m.id===1?{protocolVersion:1}:{sessionId:'ses_'+crypto.randomUUID()}}));
});`,
			],
			cwd: tmpdir(),
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'ignore',
			windowsHide: true,
		});
	}
	appendFileSync(
		capturePath,
		JSON.stringify({
			cmd: [executable, ...options.cmd.slice(1)],
			executable: selected,
			cwd: options.cwd,
			claudeConfigDir: options.env?.CLAUDE_CONFIG_DIR,
			agentGuard: options.env?.AIDD_AGENT,
			summonNonce: options.env?.SUMMON_NONCE,
			detached: options.detached,
		}) + '\n',
	);
	if (process.env.SUMMON_TEST_SPAWN_ERROR === '1') throw new Error('Simulated launch failure.');
	if (executable === 'claude' && process.env.SUMMON_TEST_CLAUDE_NO_READY !== '1') {
		const nonce = options.env?.SUMMON_NONCE;
		const name = options.env?.SUMMON_AGENT;
		if (!nonce || !name) throw new Error('Expected named Claude launch identity.');
		const runtime = join(requiredEnvironment('SUMMON_HOME'), 'runtime', name);
		mkdirSync(runtime, { recursive: true });
		writeFileSync(join(runtime, `${nonce}.ready`), nonce);
	}
	if (
		basename(executable).toLowerCase() === 'electron.exe' &&
		process.env.SUMMON_TEST_EXIT === '0'
	) {
		const receipt = options.cmd.at(-1);
		if (receipt) writeFileSync(receipt, '{}');
	}
	if (
		executable === 'codex' &&
		options.cmd[1] !== 'resume' &&
		process.env.SUMMON_TEST_CODEX_NO_HISTORY !== '1'
	) {
		const sessions = join(codexRoot, 'sessions');
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, 'test-session.jsonl'),
			JSON.stringify({
				type: 'session_meta',
				timestamp: new Date().toISOString(),
				payload: { id: 'test-codex-session', cwd: options.cwd },
			}) + '\n',
		);
	}
	if (executable === 'codex' && process.env.SUMMON_TEST_CODEX_NO_BINDING !== '1') {
		const nonce = options.env?.SUMMON_NONCE;
		const name = options.env?.SUMMON_AGENT;
		const root = options.env?.SUMMON_HOME;
		if (!nonce || !name || !root) throw new Error('Expected exact Codex launch identity.');
		const runtime = join(root, 'runtime', name);
		mkdirSync(runtime, { recursive: true });
		const id =
			process.env.SUMMON_TEST_CODEX_BINDING ??
			(options.cmd[1] === 'resume' ? (options.cmd.at(-2) ?? '') : 'test-codex-session');
		if (id === '--unsafe') writeFileSync(join(runtime, `${nonce}.binding`), id);
	}
	const binding =
		executable === 'codex' &&
		process.env.SUMMON_TEST_CODEX_NO_BINDING !== '1' &&
		process.env.SUMMON_TEST_CODEX_BINDING !== '--unsafe';
	return realSpawn({
		// Detached launcher stand-ins may outlive the CLI; do not hold its fixture cwd open.
		cwd: tmpdir(),
		cmd: [
			process.execPath,
			'--eval',
			(binding
				? 'const { bindSession } = await import(process.argv[1]); ' +
					'await bindSession({hook_event_name:"SessionStart",source:"startup",session_id:process.argv[2]}); '
				: '') +
				(process.env.SUMMON_TEST_RELEASE
					? 'const release = process.env.SUMMON_TEST_RELEASE; ' +
						'const timeout = setTimeout(() => process.exit(1), 60000); ' +
						'while (!(await Bun.file(release).exists())) await Bun.sleep(20); ' +
						'clearTimeout(timeout);'
					: 'setTimeout(() => process.exit(' +
						(process.env.SUMMON_TEST_EXIT ?? '0') +
						'), ' +
						(process.env.SUMMON_TEST_DELAY ?? '0') +
						')'),
			join(import.meta.dir, '../../src/mail-session-hook.ts'),
			process.env.SUMMON_TEST_CODEX_BINDING ??
				(options.cmd[1] === 'resume' ? (options.cmd.at(-2) ?? '') : 'test-codex-session'),
		],
		env: options.env ?? process.env,
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'ignore',
		windowsHide: true,
	});
}

// The fixture implements the object-form overload used by summon.
Bun.spawn = captureLaunch as typeof Bun.spawn;
