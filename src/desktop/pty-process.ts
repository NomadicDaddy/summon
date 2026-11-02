import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const MAX_TERMINAL_INPUT = 65536;

export function childEnvironment(source = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (
			value !== undefined &&
			!['SUMMON_AGENT', 'SUMMON_NONCE', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(
				key.toUpperCase(),
			)
		) {
			const storageKey = ['SUMMON_HOME', 'SUMMON_TEAMS_HOME'].includes(key.toUpperCase());
			env[process.platform === 'win32' && storageKey ? key.toUpperCase() : key] = value;
		}
	}
	return env;
}

export function validTerminalSize(cols: number, rows: number): boolean {
	return [cols, rows].every((value) => Number.isInteger(value) && value >= 2 && value <= 1000);
}

/** Taskkill reported a failure. The message is unchanged; owned session stops read the fields. */
export class ProcessTreeStopError extends Error {
	readonly pid: number;
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly output: string;
	constructor(pid: number, code: number | null, signal: NodeJS.Signals | null, output: string) {
		super(
			`Could not stop the session process tree (PID ${pid}; taskkill exit ${code ?? signal ?? 'unknown'}): ${output.trim() || 'no diagnostic output'}`,
		);
		this.pid = pid;
		this.code = code;
		this.signal = signal;
		this.output = output;
	}
}

/** Windows only: target the owned PID and descendants, never a process name. */
export async function killProcessTree(pid: number, alreadyGone: () => boolean): Promise<void> {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned process PID.');
	await new Promise<void>((done, reject) => {
		let output = '';
		const capture = (chunk: Buffer): void => {
			output = (output + chunk.toString('utf8')).slice(0, 8192);
		};
		const child = spawn(
			join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
			['/PID', String(pid), '/T', '/F'],
			{
				windowsHide: true,
			},
		);
		child.stdout.on('data', capture);
		child.stderr.on('data', capture);
		child.on('error', reject);
		child.on('close', (code, signal) =>
			code === 0 || alreadyGone()
				? done()
				: reject(new ProcessTreeStopError(pid, code, signal, output)),
		);
	});
}
