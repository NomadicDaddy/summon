import { expect, test } from 'bun:test';

import type { ProcessFacts, ProcessSnapshot } from '../src/session-presence.ts';

import { captureRootStart, startPrecisionMs, stopRootState } from '../src/desktop/stop-root.ts';

const self = 5000;
const root = 29480;
const since = 1_000_000;
const started = since + 40;
const exact = startPrecisionMs('win32');
const nonce = '3622ac75-edc9-4754-963b-6f8cabb7e5aa';
const launch = { since, slug: 'alpha', nonce };

function snapshotOf(entries: [number, ProcessFacts][]): ProcessSnapshot {
	return () => Promise.resolve(new Map(entries));
}
const control: [number, ProcessFacts] = [self, { name: 'electron.exe', startedAt: 1 }];
const sessionCommand = (launchNonce: string, slug = 'alpha') =>
	`"C:\\Tools\\bun.exe" D:/summon/src/cli.ts __session ${slug} --launch-nonce ${launchNonce}`;
const ownRoot: ProcessFacts = {
	name: 'bun.exe',
	parentPid: self,
	startedAt: started,
	commandLine: sessionCommand(nonce),
};
const capture = (entries: [number, ProcessFacts][]) =>
	captureRootStart(root, launch, snapshotOf(entries), self, exact);
// No defaults: a missing capture must reach stopRootState as undefined.
const read = (
	snapshot: ProcessSnapshot,
	captured: number | undefined,
	exists: (pid: number) => boolean,
) => stopRootState(root, captured, snapshot, exists, self, exact);
const absent = () => false;

test('Windows starts must match exactly; ps starts within their second', () => {
	expect(startPrecisionMs('win32')).toBe(0);
	expect(startPrecisionMs('linux')).toBe(1000);
});

test('the launch capture keeps only this launch root', async () => {
	expect(await capture([control, [root, ownRoot]])).toBe(started);
	// No positive control, no capture.
	expect(await capture([[root, ownRoot]])).toBeUndefined();
	// Not the Window's child: a reused PID belonging to something else.
	expect(await capture([control, [root, { ...ownRoot, parentPid: 4242 }]])).toBeUndefined();
	// Started before this launch began.
	expect(await capture([control, [root, { ...ownRoot, startedAt: since - 1 }]])).toBeUndefined();
	// Morgan 18e84b6d: the Window's own `bun --version` runtime check reusing the PID has the same
	// parent, program and a later start, but no session launch; it must not seed the identity.
	const runtimeCheck = {
		...ownRoot,
		commandLine: '"C:\\Tools\\bun.exe" --version',
	};
	expect(await capture([control, [root, runtimeCheck]])).toBeUndefined();
	// Another launch of the same member, or the same nonce under another member.
	const otherNonce = '9a7d7b66-0000-4000-8000-000000000000';
	expect(
		await capture([control, [root, { ...ownRoot, commandLine: sessionCommand(otherNonce) }]]),
	).toBeUndefined();
	expect(
		await capture([
			control,
			[root, { ...ownRoot, commandLine: sessionCommand(nonce, 'beta') }],
		]),
	).toBeUndefined();
	// No command line, then no start time: each field omitted, not set to undefined.
	const noCommand: ProcessFacts = { name: 'bun.exe', parentPid: self, startedAt: started };
	expect(await capture([control, [root, noCommand]])).toBeUndefined();
	// Not a Bun or Node session host.
	expect(await capture([control, [root, { ...ownRoot, name: 'cmd.exe' }]])).toBeUndefined();
	const noStart: ProcessFacts = {
		name: 'bun.exe',
		parentPid: self,
		commandLine: sessionCommand(nonce),
	};
	expect(await capture([control, [root, noStart]])).toBeUndefined();
	expect(await capture([control])).toBeUndefined();
	expect(
		await captureRootStart(
			root,
			launch,
			() => Promise.reject(new Error('pwsh timed out')),
			self,
		),
	).toBeUndefined();
});

test('a snapshot without the Window itself proves nothing', async () => {
	expect(await read(snapshotOf([]), started, absent)).toBe('unknown');
	expect(await read(snapshotOf([[root, ownRoot]]), started, absent)).toBe('unknown');
});

test('a snapshot that fails is unknown', async () => {
	expect(await read(() => Promise.reject(new Error('pwsh timed out')), started, absent)).toBe(
		'unknown',
	);
});

test('absence counts only when the operating system also says the PID is gone', async () => {
	expect(await read(snapshotOf([control]), started, () => false)).toBe('gone');
	expect(await read(snapshotOf([control]), started, () => true)).toBe('unknown');
});

test('the captured root itself is alive', async () => {
	expect(await read(snapshotOf([control, [root, ownRoot]]), started, absent)).toBe('alive');
});

test('a PID reused between launch and Stop is a different process, even 1 ms apart', async () => {
	// The old root exited, its PID was reused before Stop, and ConPTY had not reported the exit.
	for (const later of [1, -1, 30_000, -30_000])
		expect(
			await read(
				snapshotOf([control, [root, { ...ownRoot, startedAt: started + later }]]),
				started,
				absent,
			),
		).toBe('gone');
});

test('without the exact launch identity a present PID is unknown, never alive', async () => {
	expect(await read(snapshotOf([control, [root, ownRoot]]), undefined, absent)).toBe('unknown');
	expect(await read(snapshotOf([control, [root, { name: 'bun.exe' }]]), started, absent)).toBe(
		'unknown',
	);
});
