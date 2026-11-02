import { expect, test } from 'bun:test';

import { killProcessTree, ProcessTreeStopError } from '../src/desktop/pty-process.ts';

test('process termination rejects invalid owned PIDs before invoking Windows', async () => {
	for (const pid of [0, -1, 1.5, Number.NaN]) {
		const failure: unknown = await killProcessTree(pid, () => false).catch(
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		if (!(failure instanceof Error)) throw new Error('Expected invalid PID failure');
		expect(failure.message).toContain('Invalid owned process PID');
	}
});

test.skipIf(process.platform !== 'win32')(
	'Windows stop failure retains exit status and diagnostic output',
	async () => {
		// Windows process IDs are divisible by four; this cannot name a live process.
		const failure: unknown = await killProcessTree(2147483647, () => false).catch(
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		if (!(failure instanceof Error)) throw new Error('Expected taskkill failure');
		expect(failure.message).toMatch(/taskkill exit [1-9][0-9]*/);
		// The same message, now typed so an owned session stop can keep its intent.
		expect(failure).toBeInstanceOf(ProcessTreeStopError);
		if (failure instanceof ProcessTreeStopError) expect(failure.code).toBeGreaterThan(0);
		expect(failure.message).toContain('2147483647');
		expect(failure.message).not.toContain('no diagnostic output');
	},
);

test.skipIf(process.platform !== 'win32')(
	'process termination stops an owned child through the shared Windows helper',
	async () => {
		const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
			stdin: 'ignore',
			stdout: 'ignore',
			stderr: 'ignore',
			windowsHide: true,
		});
		try {
			expect(child.exitCode).toBeNull();
			await killProcessTree(child.pid, () => child.exitCode !== null);
			await child.exited;
			expect(child.exitCode).not.toBeNull();
		} finally {
			child.kill();
			await child.exited;
		}
	},
);
