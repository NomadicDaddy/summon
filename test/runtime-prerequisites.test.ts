import { expect, mock, test } from 'bun:test';

import { runtimeVersionStatus } from '../src/runtime-prerequisites.ts';

const versions = new Map<string, string | Error>();
const calls: { command: string; args: string[] }[] = [];
await mock.module('../src/executable.ts', () => ({
	resolveExecutable: (name: string) =>
		versions.has(name.replace('.exe', '')) ? name : undefined,
}));
await mock.module('node:child_process', () => ({
	execFile: (
		command: string,
		args: string[],
		_options: unknown,
		callback: (error: Error | null, stdout: string, stderr: string) => void,
	) => {
		calls.push({ command, args });
		const value = versions.get(command.replace('.exe', ''));
		callback(value instanceof Error ? value : null, typeof value === 'string' ? value : '', '');
	},
}));
const { probeRuntimePrerequisites } = await import('../src/runtime-prerequisite-probe.ts');

test('prerequisite discovery checks only resolved Bun and pwsh and never treats old or failed as found', async () => {
	versions.clear();
	expect((await probeRuntimePrerequisites()).map((item) => item.status)).toEqual([
		'missing',
		'missing',
	]);
	expect(calls).toEqual([]);
	versions.set('bun', '1.4.2\n');
	versions.set('pwsh', 'PowerShell 7.5.9\n');
	expect((await probeRuntimePrerequisites()).map((item) => item.status)).toEqual([
		'outdated',
		'outdated',
	]);
	versions.set('bun', '1.4.3\n');
	versions.set('pwsh', 'PowerShell 7.6.0\n');
	expect((await probeRuntimePrerequisites()).map((item) => item.status)).toEqual([
		'available',
		'available',
	]);
	versions.set('bun', new Error('private executable path'));
	versions.set('pwsh', '\x1b[31mPowerShell 7.6.6\x1b[0m');
	const failed = await probeRuntimePrerequisites();
	expect(failed.map((item) => item.status)).toEqual(['unavailable', 'unavailable']);
	expect(JSON.stringify(failed)).not.toContain('private');
	for (const call of calls) {
		expect(call.command).toMatch(/^(?:bun|pwsh)(?:\.exe)?$/);
		expect(call.args).toEqual(['--version']);
	}
});

test('version boundaries require a verifiable stable release and compare numerically', () => {
	for (const version of ['1.4.2', '1.3.99', '0.99.99'])
		expect(runtimeVersionStatus('bun', version).status).toBe('outdated');
	for (const version of ['1.4.3', '1.4.10', '1.10.0', '2.0.0'])
		expect(runtimeVersionStatus('bun', version).status).toBe('available');
	for (const version of ['', 'unknown', '1.4.3-canary', '1.4.3\nother', '7.6.0-preview.1'])
		expect(runtimeVersionStatus('bun', version).status).toBe('unavailable');
	expect(runtimeVersionStatus('pwsh', 'PowerShell 5.1.0').status).toBe('outdated');
	expect(runtimeVersionStatus('pwsh', 'PowerShell 7.6.6').status).toBe('available');
});
