import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { mailHarness } from './fixtures/mail-harness.ts';
import { publishOwnedPids } from './fixtures/owned-command-readiness.ts';
import { ownedCommand, terminateOwnedCommand } from './fixtures/owned-command.ts';

const entry = join(import.meta.dir, 'fixtures/owned-command-child.ts');
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
		throw error;
	}
}
async function ready(root: string): Promise<{ root: number; shell: number }> {
	const until = Date.now() + 2500;
	while (Date.now() < until) {
		try {
			const pids = JSON.parse(await readFile(join(root, 'pids.json'), 'utf8')) as {
				root: number;
				shell: number;
			};
			if (Number(await readFile(join(root, 'shell-ready'), 'utf8')) === pids.shell)
				return pids;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		await Bun.sleep(20);
	}
	throw new Error('Disposable shell did not signal readiness.');
}

test('PID readiness publishes only complete JSON while its writer is paused', async () => {
	const fixture = await mailHarness();
	const pids = { root: 123, shell: 456 };
	let releaseWrite = () => {};
	const writing = new Promise<void>((resolve) => {
		releaseWrite = resolve;
	});
	let partialWritten = () => {};
	const partial = new Promise<void>((resolve) => {
		partialWritten = resolve;
	});
	const publication = publishOwnedPids(fixture.root, pids, async (path, contents) => {
		await writeFile(path, '{');
		partialWritten();
		await writing;
		await writeFile(path, contents);
	});
	try {
		await partial;
		const beforePublication = await readFile(join(fixture.root, 'pids.json'), 'utf8').catch(
			(error: unknown) => error,
		);
		expect(beforePublication).toMatchObject({ code: 'ENOENT' });
		releaseWrite();
		await publication;
		await writeFile(join(fixture.root, 'shell-ready'), String(pids.shell));
		expect(await ready(fixture.root)).toEqual(pids);
	} finally {
		releaseWrite();
		await publication;
		await fixture.dispose();
	}
});

test('owned command collects normal exit and both pipes', async () => {
	const fixture = await mailHarness();
	const command = ownedCommand([entry, 'normal', fixture.root], process.env);
	try {
		expect(await command.completion).toEqual({
			exit: 0,
			stdout: 'normal output\n',
			stderr: 'normal diagnostic\n',
			timedOut: false,
		});
		expect(command.isClosed()).toBe(true);
	} finally {
		if (command.isClosed()) await fixture.dispose();
		else console.error(`Retained fixture ${fixture.root}; root PID ${command.child.pid}`);
	}
});

test('deadline kills the positively observed root and hanging shell and closes pipes', async () => {
	const fixture = await mailHarness();
	const command = ownedCommand([entry, 'hang', fixture.root], process.env);
	try {
		const pids = await ready(fixture.root);
		expect(command.child.pid).toBe(pids.root);
		expect(alive(pids.root)).toBe(true);
		expect(alive(pids.shell)).toBe(true);
		const result = await command.completion;
		expect(result.timedOut).toBe(true);
		expect(result.exit).not.toBe(0);
		expect(command.isClosed()).toBe(true);
		expect(alive(pids.root)).toBe(false);
		expect(alive(pids.shell)).toBe(false);
	} finally {
		if (command.isClosed()) await fixture.dispose();
		else console.error(`Retained fixture ${fixture.root}; root PID ${command.child.pid}`);
	}
}, 10000);

for (const delayedRead of [false, true]) {
	test(`termination failure retains the live fixture (${delayedRead ? 'delayed' : 'immediate'} read)`, async () => {
		const fixture = await mailHarness();
		let reportRefusal = () => {};
		const refusalReached = new Promise<void>((resolve) => {
			reportRefusal = resolve;
		});
		const command = ownedCommand([entry, 'hang', fixture.root], process.env, 3500, () => {
			reportRefusal();
			return Promise.reject(new Error('Injected termination refusal'));
		});
		const failure = command.completion.catch((error: unknown) => error);
		try {
			const pids = await ready(fixture.root);
			if (delayedRead) {
				await refusalReached;
				// Consume on a later event-loop turn, after an unhandled rejection would surface.
				await Bun.sleep(0);
			}
			const refusal: unknown = await failure;
			expect(refusal).toBeInstanceOf(Error);
			expect((refusal as Error).message).toBe('Injected termination refusal');
			expect(command.isClosed()).toBe(false);
			expect(alive(pids.root)).toBe(true);
			expect(alive(pids.shell)).toBe(true);
			expect(await readFile(join(fixture.root, 'shell-ready'), 'utf8')).toBe(
				String(pids.shell),
			);
		} finally {
			try {
				if (command.child.pid) await terminateOwnedCommand(command.child.pid);
				const until = Date.now() + 2000;
				while (!command.isClosed() && Date.now() < until) await Bun.sleep(20);
				if (command.isClosed()) await fixture.dispose();
			} finally {
				if (!command.isClosed())
					console.error(
						`Retained fixture ${fixture.root}; root PID ${command.child.pid}`,
					);
			}
		}
	}, 10000);
}
