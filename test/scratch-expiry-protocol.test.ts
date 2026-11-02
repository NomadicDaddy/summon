import { expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expireScratch, expiryLine } from '../src/scratch-retention.ts';
import { file, old, scratchStore, SLOW, startedAt, winTest } from './fixtures/scratch-store.ts';

// Morgan's v2 Medium: the worker deletes nothing until the parent has accepted ready and sent
// 'start', and a stop after that is reported as incomplete, never as a final count.
const at = scratchStore();
const { scratch } = at;
const worker = join(import.meta.dir, '..', 'scripts', 'scratch-expiry.ps1');

/** Runs the real worker, reads its ready line, then sends `answer` (or closes stdin). */
async function withoutStart(answer: string | undefined) {
	const child = Bun.spawn({
		cmd: ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', worker],
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	const cutoff = (BigInt(startedAt - 30 * 86_400_000) + 11_644_473_600_000n) * 10_000n;
	await child.stdin.write(
		`${JSON.stringify({ root: scratch(), cutoff: cutoff.toString(), pause: false })}\n`,
	);
	await child.stdin.flush();
	const reader = child.stdout.getReader();
	const ready = new TextDecoder().decode((await reader.read()).value);
	if (answer !== undefined) {
		await child.stdin.write(`${answer}\n`);
		await child.stdin.flush();
	}
	await child.stdin.end();
	const code = await child.exited;
	reader.releaseLock();
	return { ready, code, stderr: await new Response(child.stderr).text() };
}

for (const [label, answer] of [
	['closes without answering', undefined],
	['answers anything but start', 'begin'],
] as const) {
	winTest(
		`the worker removes nothing when the parent ${label} after ready`,
		async () => {
			await file(scratch('ada', 'old.txt'), old);
			const result = await withoutStart(answer);
			expect(JSON.parse(result.ready)).toEqual({ ready: true, state: 'present' });
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('Scratch expiry stopped');
			expect(existsSync(scratch('ada', 'old.txt'))).toBe(true);
		},
		SLOW,
	);
}

winTest(
	'a stop after one removal is incomplete: no final count and no "nothing removed"',
	async () => {
		await file(scratch('ada', 'a.txt'), old);
		await file(scratch('ada', 'b.txt'), old);
		let seen = 0;
		const report = await expireScratch(at.store, startedAt, {
			beforeRemove: () => {
				seen++;
				if (seen === 2) throw new Error('interrupted');
			},
		});
		expect(report.refused).toBeUndefined();
		expect(report.incomplete).toStartWith('the scratch expiry helper stopped');
		const remaining = ['a.txt', 'b.txt'].filter((name) => existsSync(scratch('ada', name)));
		expect(remaining).toHaveLength(1);
		const line = expiryLine(report);
		expect(line).toContain('Some files may have been removed; the final counts are unknown.');
		expect(line).not.toContain('Nothing was removed');
		expect(line).not.toContain('removed 0');
	},
	SLOW,
);

winTest(
	'a malformed ready refuses, and a malformed final report is incomplete, not a success',
	async () => {
		const helper = (name: string, body: string) => {
			const path = join(at.base, name);
			return writeFile(path, body).then(() => path);
		};
		const badReady = await helper('bad-ready.ps1', '[Console]::WriteLine(\'{"ready":1}\')\n');
		const refused = await expireScratch(at.store, startedAt, { helper: badReady });
		expect(refused.refused).toStartWith('the scratch expiry helper could not start');
		const badReport = await helper(
			'bad-report.ps1',
			[
				'[Console]::ReadLine() | Out-Null',
				`[Console]::WriteLine('{"ready":true,"state":"present"}')`,
				"if ([Console]::ReadLine() -ne 'start') { exit 1 }",
				`[Console]::WriteLine('{"report":{"removedFiles":-1}}')`,
			].join('\n'),
		);
		const incomplete = await expireScratch(at.store, startedAt, { helper: badReport });
		expect(incomplete.refused).toBeUndefined();
		expect(incomplete.incomplete).toStartWith(
			'the scratch expiry helper stopped before reporting',
		);
		expect(expiryLine(incomplete)).toContain('the final counts are unknown');
	},
	SLOW,
);

const READY = `[Console]::WriteLine('{"ready":true,"state":"present"}')`;
const AWAIT_START = "if ([Console]::ReadLine() -ne 'start') { exit 1 }";

/** A fake worker that records its PID, runs `steps`, then stays alive until it is killed. */
async function hangingHelper(name: string, steps: string[]) {
	const pidFile = join(at.base, `${name}.pid`);
	const path = join(at.base, `${name}.ps1`);
	await writeFile(
		path,
		[
			`[IO.File]::WriteAllText('${pidFile}', "$PID")`,
			'[Console]::ReadLine() | Out-Null',
			...steps,
			'Start-Sleep -Seconds 600',
		].join('\n'),
	);
	return { path, pid: async () => Number(await readFile(pidFile, 'utf8')) };
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// Morgan's v3 Medium: every failure path ends and reaps this worker before reading its stderr.
for (const [label, steps, limits, outcome] of [
	[
		'an invalid report from a worker that stays alive',
		[READY, AWAIT_START, `[Console]::WriteLine('{"report":{"removedFiles":-1}}')`],
		{},
		'incomplete',
	],
	[
		'an unexpected line from a worker that stays alive',
		[READY, AWAIT_START, `[Console]::WriteLine('{"hello":1}')`],
		{},
		'incomplete',
	],
	['a worker that never sends ready', [], { startLimitMs: 1500 }, 'refused'],
	['a worker silent after start', [READY, AWAIT_START], { runLimitMs: 1500 }, 'incomplete'],
] as const) {
	winTest(
		`${label} settles promptly as ${outcome}, and the worker is gone`,
		async () => {
			const helper = await hangingHelper(label.replaceAll(' ', '-'), [...steps]);
			const began = Date.now();
			const report = await expireScratch(at.store, startedAt, {
				helper: helper.path,
				...limits,
			});
			expect(Date.now() - began).toBeLessThan(15_000);
			expect(report[outcome]).toBeString();
			expect(report[outcome === 'refused' ? 'incomplete' : 'refused']).toBeUndefined();
			expect(alive(await helper.pid())).toBe(false);
		},
		SLOW,
	);
}
