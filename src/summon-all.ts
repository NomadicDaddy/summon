import { resolve } from 'node:path';

import { operatorScratchExpiry } from './scratch-retention.ts';
import { alreadyRunning, isAgentRunning } from './session-lock.ts';
import { type AgentRecord, listAgentSlugs, loadAgent } from './store.ts';
import { assertDirectory, openTerminal, terminalCommand } from './terminal.ts';

/**
 * Opens a terminal session for every registered agent, in name order, exactly as summoning each
 * name alone would. Nothing is registered or rewritten: records only change when their sessions
 * start. An agent whose record cannot be read or whose working directory is gone is reported and
 * skipped so the rest still open; the exit code marks the shortfall.
 */
export async function summonAllAgents(newWindow: boolean): Promise<void> {
	await operatorScratchExpiry();
	const entries = await listAgentSlugs();
	let count = 0;
	let failed = false;
	for (const slug of entries) {
		let record: AgentRecord | undefined;
		try {
			record = await loadAgent(slug);
		} catch (error: unknown) {
			console.error(
				`Cannot summon ${slug}.json: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exitCode = 1;
			failed = true;
			continue;
		}
		if (!record) continue;
		if (record.hibernation?.active) {
			console.log(`Skipped ${record.name}: hibernated by the operator.`);
			count += 1;
			continue;
		}
		if (await isAgentRunning(slug)) {
			alreadyRunning(record.name);
			count += 1;
			continue;
		}
		try {
			await assertDirectory(record.cwd);
		} catch (error: unknown) {
			console.error(
				`Cannot summon ${record.name}: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exitCode = 1;
			failed = true;
			continue;
		}
		const command = terminalCommand(
			resolve(import.meta.dir, 'cli.ts'),
			slug,
			record.provider,
			record.cwd,
			false,
			newWindow,
		);
		if (!command) {
			console.error(
				'No supported terminal launcher found; summon all needs one to open a window per agent. Summon each name with --same-window instead.',
			);
			process.exitCode = 1;
			return;
		}
		await openTerminal(command);
		console.log(`Summoned ${record.name} with ${record.provider}.`);
		count += 1;
	}
	if (count === 0 && !failed) console.log('No registered agents found.');
}
