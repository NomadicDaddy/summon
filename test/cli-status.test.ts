import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { cliStatuses } from '../src/desktop/cli-status.ts';
import { providerLabels } from '../src/desktop/provider-labels.ts';

let directory: string;
let previousPath: string | undefined;
let previousExtensions: string | undefined;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'summon-cli-status-'));
	previousPath = process.env.PATH;
	previousExtensions = process.env.PATHEXT;
	process.env.PATH = directory;
	if (process.platform === 'win32') process.env.PATHEXT = '.CMD;.EXE';
});
afterEach(async () => {
	if (previousPath === undefined) delete process.env.PATH;
	else process.env.PATH = previousPath;
	if (previousExtensions === undefined) delete process.env.PATHEXT;
	else process.env.PATHEXT = previousExtensions;
	if (
		dirname(resolve(directory)) !== resolve(tmpdir()) ||
		!basename(directory).startsWith('summon-cli-status-')
	)
		throw new Error('Invalid fixture cleanup path.');
	await rm(directory, { recursive: true, force: true });
});

async function provider(name: string, lines: string[], code = 0): Promise<void> {
	const windows = process.platform === 'win32';
	const script = windows
		? ['@echo off', ...lines.map((line) => `echo(${line}`), `exit /b ${code}`].join('\r\n')
		: ['#!/bin/sh', ...lines.map((line) => `printf '%s\\n' '${line}'`), `exit ${code}`].join(
				'\n',
			);
	await writeFile(join(directory, name + (windows ? '.cmd' : '')), script, { mode: 0o755 });
}

test('an empty isolated PATH marks every supported provider missing', async () => {
	const result = await cliStatuses();
	expect(Object.keys(providerLabels)).toEqual(result.map((entry) => entry.provider));
	expect(result.every((entry) => entry.status === 'missing')).toBe(true);
});

test('a working CLI selects and strips the version line while other providers stay missing', async () => {
	await provider('claude', ['', 'Starting', '\u001b[32mclaude 9.9.9\u001b[0m']);
	const result = await cliStatuses();
	expect(result.find((entry) => entry.provider === 'claude')).toEqual({
		provider: 'claude',
		status: 'available',
		detail: 'claude 9.9.9',
	});
	expect(
		result
			.filter((entry) => entry.provider !== 'claude')
			.every((entry) => entry.status === 'missing'),
	).toBe(true);
});

test('a successful command without a version stays available', async () => {
	await provider('codex', ['ready']);
	expect((await cliStatuses()).find((entry) => entry.provider === 'codex')).toEqual({
		provider: 'codex',
		status: 'available',
		detail: 'Version not reported',
	});
});

test('a failed command is unavailable even when it prints a version', async () => {
	await provider('grok', ['grok 1.2.3'], 1);
	expect((await cliStatuses()).find((entry) => entry.provider === 'grok')?.status).toBe(
		'unavailable',
	);
});

test('version details are capped at 160 characters', async () => {
	await provider('kilo', ['7'.repeat(300)]);
	expect((await cliStatuses()).find((entry) => entry.provider === 'kilo')?.detail).toBe(
		'7'.repeat(160),
	);
});
