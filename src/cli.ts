#!/usr/bin/env bun

import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { runSession } from './session.ts';
import {
	appendNote,
	loadAgent,
	newRecord,
	isProvider,
	saveAgent,
	slugFor,
	type Provider,
} from './store.ts';
import { openTerminal, terminalCommand } from './terminal.ts';

interface Options {
	name: string;
	provider?: Provider;
	notes: string[];
	cwd?: string;
	sameWindow: boolean;
}

const HELP = `summon <name> [options]

Open a named coding-agent session in a new terminal window.

Options:
  --using <claude|codex>  CLI for a new name (default: claude; saved for later calls)
  --note <text>           Append a persistent note before opening
  --cwd <path>            Set or replace the session working directory
  --same-window           Run here instead of opening a new window
  -h, --help              Show this help

Examples:
  summon carl
  summon auden --using codex
  summon carl --note "Owns the release checklist" --cwd ./my-project

Each name uses its registered CLI. --using cannot switch an existing name.\nRecords are stored as JSON files in ~/.agent.`;

async function main(args: string[]): Promise<void> {
	if (args[0] === '__session') {
		const slug = args[1];
		if (!slug || args.length !== 2) throw new Error('Invalid internal session command.');
		process.exitCode = await runSession(slugFor(slug));
		return;
	}

	if (args.includes('--help') || args.includes('-h')) {
		console.log(HELP);
		return;
	}

	const options = parseOptions(args);
	const slug = slugFor(options.name);
	const existing = await loadAgent(slug);
	if (existing && options.provider && options.provider !== existing.provider) {
		throw new Error(
			`${existing.name} is registered with ${existing.provider}. Omit --using, or register a different name for ${options.provider}.`,
		);
	}
	const cwd = options.cwd ? resolve(options.cwd) : (existing?.cwd ?? process.cwd());
	await assertDirectory(cwd);

	const record = existing ?? newRecord(options.name, cwd, options.provider ?? 'claude');
	record.cwd = cwd;
	for (const note of options.notes) {
		appendNote(record, note);
	}
	await saveAgent(slug, record);

	if (options.sameWindow) {
		process.exitCode = await runSession(slug);
		return;
	}

	const command = terminalCommand(import.meta.path, slug, record.provider, record.cwd);
	if (!command) {
		console.warn('No supported terminal launcher found; opening the session here.');
		process.exitCode = await runSession(slug);
		return;
	}
	openTerminal(command);
	console.log(`Summoned ${record.name} with ${record.provider}.`);
}

function parseOptions(args: string[]): Options {
	const name = args[0];
	if (!name || name.startsWith('-')) throw new Error(`A name is required.\n\n${HELP}`);
	const result: Options = { name, notes: [], sameWindow: false };

	for (let index = 1; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === '--same-window') {
			result.sameWindow = true;
			continue;
		}
		if (argument === '--using') {
			const provider = args[++index];
			if (!isProvider(provider)) throw new Error('--using must be claude or codex.');
			result.provider = provider;
			continue;
		}
		if (argument === '--note') {
			const note = args[++index];
			if (!note) throw new Error('--note requires text.');
			result.notes.push(note);
			continue;
		}
		if (argument === '--cwd') {
			const cwd = args[++index];
			if (!cwd) throw new Error('--cwd requires a path.');
			result.cwd = cwd;
			continue;
		}
		throw new Error(`Unknown option: ${argument}`);
	}
	return result;
}

async function assertDirectory(path: string): Promise<void> {
	const details = await stat(path).catch(() => undefined);
	if (!details?.isDirectory()) throw new Error(`Working directory does not exist: ${path}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
