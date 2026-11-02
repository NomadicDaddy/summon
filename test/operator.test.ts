import type { IPtyForkOptions } from 'node-pty';

import { expect, test } from 'bun:test';

import type { TerminalProcess } from '../src/desktop/team.ts';
import type { OperatorEvent } from '../src/desktop/types.ts';

import { OperatorTerminal } from '../src/desktop/operator.ts';
import { childEnvironment } from '../src/desktop/pty-process.ts';

test('child shells remove inherited identity and injection options regardless of casing', () => {
	expect(
		childEnvironment({
			summon_agent: 'parent',
			SUMMON_NONCE: 'nonce',
			Electron_Run_As_Node: '1',
			node_options: '--inspect',
			PATH: 'retained',
		}),
	).toEqual({ PATH: 'retained' });
});

test.skipIf(process.platform !== 'win32')(
	'storage environment casing cannot keep a stale child root',
	() => {
		const env = childEnvironment({ summon_home: 'old', Summon_Teams_Home: 'old base' });
		env.SUMMON_HOME = 'selected root';
		env.SUMMON_TEAMS_HOME = 'selected base';
		expect(env).toEqual({ SUMMON_HOME: 'selected root', SUMMON_TEAMS_HOME: 'selected base' });
	},
);

test('operator shell uses only detected choices, owns one session and validates terminal traffic', async () => {
	const events: OperatorEvent[] = [];
	const writes: string[] = [];
	const sizes: number[][] = [];
	const launches: { path: string; args: string[]; options: IPtyForkOptions }[] = [];
	let exit: (event: { exitCode: number }) => void = () => {};
	const pty: TerminalProcess = {
		pid: 1,
		onData: () => ({ dispose: () => {} }),
		onExit: (listener) => {
			exit = listener;
			return { dispose: () => {} };
		},
		write: (text) => {
			writes.push(String(text));
		},
		resize: (cols, rows) => {
			sizes.push([cols, rows]);
		},
		kill: () => {},
	};
	const operator = new OperatorTerminal(
		[{ id: 'fixture', label: 'Fixture shell', path: 'fixture.exe', args: ['-i'] }],
		'D:/fixture',
		(event) => {
			events.push(event);
		},
		(path, args, options) => {
			launches.push({ path, args, options });
			return pty;
		},
	);
	expect(() => operator.start('injected.exe', 100, 30)).toThrow('Unknown shell');
	expect(() => operator.start('fixture', 0, 30)).toThrow('Invalid terminal size');
	operator.start('fixture', 120, 25);
	expect(() => operator.start('fixture', 120, 25)).toThrow('Stop the current');
	expect(launches[0]?.options.cwd).toBe('D:/fixture');
	expect(launches[0]?.args).toEqual(['-i']);
	expect(launches[0]?.options.env?.SUMMON_AGENT).toBeUndefined();
	expect(launches[0]?.options.env?.SUMMON_NONCE).toBeUndefined();
	operator.input('hello');
	expect(() => operator.input('x'.repeat(65537))).toThrow('too large');
	operator.resize(160, 35);
	operator.resize(-2, 0);
	expect(writes).toEqual(['hello']);
	expect(sizes).toEqual([[160, 35]]);
	exit({ exitCode: 0 });
	operator.input('after exit');
	expect(writes).toEqual(['hello']);
	operator.start('fixture', 80, 20);
	expect(launches).toHaveLength(2);
	exit({ exitCode: 3 });
	expect(events.at(-1)).toEqual({ type: 'exited', exitCode: 3 });
	await operator.shutdown();
	expect(() => operator.start('fixture', 80, 20)).toThrow('stopping');
});

test('operator recovers from failed shutdown and from another session aborting window close', async () => {
	let exit: (event: { exitCode: number }) => void = () => {};
	const pty: TerminalProcess = {
		pid: 1,
		onData: () => ({ dispose: () => {} }),
		onExit: (listener) => {
			exit = listener;
			return { dispose: () => {} };
		},
		write: () => {},
		resize: () => {},
		kill: () => {
			throw new Error('Fixture stop failed');
		},
	};
	const operator = new OperatorTerminal(
		[{ id: 'fixture', label: 'Fixture', path: 'fixture', args: [] }],
		'D:/fixture',
		() => {},
		() => pty,
		() => Promise.reject(new Error('Fixture stop failed')),
	);
	operator.start('fixture', 80, 20);
	expect(await operator.shutdown().catch((error: unknown) => String(error))).toContain(
		'Fixture stop failed',
	);
	exit({ exitCode: 0 });
	expect(() => operator.start('fixture', 80, 20)).not.toThrow();
	exit({ exitCode: 0 });
	await operator.shutdown();
	operator.cancelShutdown();
	expect(() => operator.start('fixture', 80, 20)).not.toThrow();
	exit({ exitCode: 0 });
});
