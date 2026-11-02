import { readFile } from 'node:fs/promises';

import { atomicWrite } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import { assertNotesLimit } from './notes-limit.ts';
import { acquireSessionLock } from './session-lock.ts';
import {
	type AgentRecord,
	isProvider,
	loadAgent,
	notesPath,
	type Provider,
	saveAgent,
	slugFor,
} from './store.ts';

/**
 * A new teammate with another's memory and none of their session.
 *
 * The record name, provider, and an empty session list are the clone's own. Expertise and the
 * notes file are the source's knowledge. The source's provider session is not copied: a Codex
 * session id cannot be resumed by Grok. Domain authority is not copied either, so the roster
 * still names the original as the primary. The source's domain text is quoted in the notes.
 */
export async function cloneAgent(
	sourceName: string,
	targetName: string,
	provider?: Provider,
): Promise<{ slug: string; provider: Provider }> {
	operatorOnly();
	const sourceSlug = slugFor(sourceName);
	const targetSlug = slugFor(targetName);
	if (sourceSlug === targetSlug) throw new Error('A clone needs a different name.');
	const source = await loadAgent(sourceSlug);
	if (!source) throw new Error(`No agent named ${sourceName}.`);
	if (await loadAgent(targetSlug)) throw new Error(`${targetName} is already registered.`);
	const chosen = provider ?? source.provider;
	const now = new Date().toISOString();
	const record: AgentRecord = {
		version: 3,
		name: targetName.trim(),
		expertise: cloneExpertise(targetName.trim(), source, chosen, now),
		cwd: source.cwd,
		createdAt: now,
		updatedAt: now,
		provider: chosen,
		sessions: [],
	};
	const notes = await readFile(notesPath(sourceSlug), 'utf8').catch(() => '');
	const body = notes.trimEnd();
	const cloned = `${body}${body ? '\n\n' : ''}${cloneNote(targetName.trim(), source, chosen, now)}\n`;
	assertNotesLimit(cloned);
	// Hold the target name's lock as the CLI does: a session left running under a reused name
	// refuses the clone before registration seeds that name's cursors.
	const lock = await acquireSessionLock(targetSlug);
	if (!lock)
		throw new Error(
			`A session is still running under the name ${targetName.trim()}; stop it before registering the name again.`,
		);
	try {
		await saveAgent(targetSlug, record, true);
		await atomicWrite(notesPath(targetSlug), cloned);
	} finally {
		await lock.release();
	}
	return { slug: targetSlug, provider: chosen };
}

function cloneExpertise(
	targetName: string,
	source: AgentRecord,
	provider: Provider,
	at: string,
): string {
	const header = `${targetName} is a ${provider} clone of ${source.name}'s record as of ${at}. ${targetName} is not ${source.name}. ${source.name}'s ${source.provider} session was not copied.`;
	const remaining = 8000 - header.length - 2;
	if (remaining < 1) throw new Error('Clone identity is too long.');
	const expertise = source.expertise.trim();
	return `${header}\n\n${expertise.length <= remaining ? expertise : `${expertise.slice(0, remaining - 1)}…`}`;
}

function cloneNote(
	targetName: string,
	source: AgentRecord,
	provider: Provider,
	at: string,
): string {
	const domain = source.domain?.trim();
	return [
		`## Clone identity ${at}`,
		'',
		`You are ${targetName}, not ${source.name}. The notes above were copied from ${source.name}'s record at this time, so you have that memory. ${source.name} remains a separate ${source.provider} teammate. This session is ${provider}. ${source.name}'s session id was not copied, and you must not resume it. Your mailbox is ${slugFor(targetName)}, and it starts empty.`,
		'',
		domain
			? `${source.name}'s domain, copied here as knowledge and not as authority: ${domain}`
			: `${source.name} had no domain recorded. This clone does not claim one either.`,
		'',
		`Domain authority was not copied. ${source.name} remains the primary unless the user assigns it.`,
	].join('\n');
}

export function cloneCommand(args: string[]): Promise<{ slug: string; provider: Provider }> {
	const source = args[0];
	const target = args[1];
	if (!source || !target || source.startsWith('-') || target.startsWith('-')) {
		throw new Error('Usage: summon clone <source> <name> [--using claude|codex|grok|kilo]');
	}
	let provider: Provider | undefined;
	for (let index = 2; index < args.length; index++) {
		const argument = args[index];
		if (argument !== '--using') throw new Error(`Unexpected ${argument ?? ''}.`);
		const value = args[++index];
		if (!isProvider(value)) throw new Error('--using must be claude, codex, grok, or kilo.');
		provider = value;
	}
	return cloneAgent(source, target, provider);
}
