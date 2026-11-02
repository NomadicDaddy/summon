import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { parseOwner, processAlive } from '../src/process-owner.ts';

test('owners require safe process IDs and UUID nonces, retaining live children', async () => {
	const nonce = randomUUID();
	expect(parseOwner(JSON.stringify({ pid: process.pid, nonce }))).toEqual({
		pid: process.pid,
		nonce,
	});
	for (const text of [
		'',
		'{',
		'null',
		'{}',
		JSON.stringify({ pid: 0, nonce }),
		JSON.stringify({ pid: process.pid, nonce: '../invalid' }),
		JSON.stringify({ pid: process.pid, nonce, childPid: -1 }),
	])
		expect(parseOwner(text)).toBeUndefined();
	expect(processAlive(0)).toBe(false);
	const child = Bun.spawn([process.execPath, '-e', 'process.exit(0)'], { windowsHide: true });
	await child.exited;
	expect(processAlive(child.pid)).toBe(false);
	expect(processAlive(process.pid)).toBe(true);
});
