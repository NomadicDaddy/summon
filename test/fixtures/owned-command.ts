import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** Test-owned roots only. A vanished Windows root cannot prove its descendants stopped. */
export async function terminateOwnedCommand(pid: number): Promise<void> {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned fixture PID.');
	if (process.platform !== 'win32') {
		process.kill(-pid, 'SIGKILL');
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const killer = spawn(
			join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
			['/PID', String(pid), '/T', '/F'],
			{ windowsHide: true, timeout: 2000 },
		);
		let diagnostic = '';
		killer.stdout.on('data', (chunk: Buffer) => {
			diagnostic += chunk.toString();
		});
		killer.stderr.on('data', (chunk: Buffer) => {
			diagnostic += chunk.toString();
		});
		killer.on('error', reject);
		killer.on('close', (code, signal) => {
			if (code === 0) resolve();
			else
				reject(
					new Error(
						`Owned fixture ${pid} termination failed (${code ?? signal}): ${diagnostic}`,
					),
				);
		});
	});
}

/** close includes pipe completion; the deadline does not depend on Bun's test callback. */
export function ownedCommand(
	args: string[],
	env: NodeJS.ProcessEnv,
	deadlineMs = 3500,
	terminate = terminateOwnedCommand,
) {
	const child = spawn(process.execPath, args, {
		env,
		windowsHide: true,
		detached: process.platform !== 'win32',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});
	let closed = false;
	let timedOut = false;
	const completion = new Promise<{
		exit: number | null;
		stdout: string;
		stderr: string;
		timedOut: boolean;
	}>((resolve, reject) => {
		let cancellation: Promise<void> = Promise.resolve();
		let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
		const deadline = setTimeout(() => {
			timedOut = true;
			shutdownTimer = setTimeout(
				() =>
					reject(
						new Error(
							`Fixture ${child.pid} pipes did not close after cancellation; retain fixture directory.`,
						),
					),
				3000,
			);
			// Never signal a possibly reused Windows PID after the root has exited.
			cancellation =
				child.pid &&
				(process.platform !== 'win32' ||
					(child.exitCode === null && child.signalCode === null))
					? terminate(child.pid)
					: Promise.reject(
							new Error(
								'Fixture root exited before pipe completion; descendant cleanup is unproven.',
							),
						);
			void cancellation.catch((error: unknown) => {
				clearTimeout(shutdownTimer);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		}, deadlineMs);
		child.on('error', (error) => {
			clearTimeout(deadline);
			reject(error);
		});
		child.on('close', (exit) => {
			closed = true;
			clearTimeout(deadline);
			clearTimeout(shutdownTimer);
			void cancellation.then(() => resolve({ exit, stdout, stderr, timedOut }), reject);
		});
	});
	return { child, completion, isClosed: () => closed };
}
