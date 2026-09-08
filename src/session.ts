import { randomUUID } from 'node:crypto';
import { findNewCodexSession } from './codex-sessions.ts';
import { providerCommand } from './providers.ts';
import { forgetSession, latestSession, loadAgent, rememberSession, saveAgent } from './store.ts';

export async function runSession(slug: string): Promise<number> {
	const record = await loadAgent(slug);
	if (!record) throw new Error(`No stored agent named ${slug}.`);

	const existing = latestSession(record);
	const sessionId = existing?.id ?? (record.provider === 'claude' ? randomUUID() : undefined);
	const command = providerCommand(record, sessionId);
	if (sessionId) {
		rememberSession(record, sessionId);
		await saveAgent(slug, record);
	}

	const startedAt = Date.now();
	try {
		const child = Bun.spawn({
			cmd: command,
			cwd: record.cwd,
			stdin: 'inherit',
			stdout: 'inherit',
			stderr: 'inherit',
		});
		const exitCode = await child.exited;
		if (record.provider === 'codex' && !existing) {
			const discovered = await findNewCodexSession(record.cwd, startedAt);
			if (discovered) {
				const current = (await loadAgent(slug)) ?? record;
				rememberSession(current, discovered);
				await saveAgent(slug, current);
			} else {
				console.error('Codex exited before summon could find a session to remember.');
			}
		}
		return exitCode;
	} catch (error: unknown) {
		if (!existing && sessionId) {
			const current = (await loadAgent(slug)) ?? record;
			forgetSession(current, sessionId);
			await saveAgent(slug, current);
		}
		throw error;
	}
}
