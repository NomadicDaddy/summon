import type { AgentRecord, Provider } from './store.ts';

export function sessionPrompt(record: AgentRecord): string {
	const notes = record.notes.trim() || '(No persistent notes yet.)';
	return [
		`You are being summoned as ${record.name}.`,
		'',
		'Persistent notes for this named session:',
		notes,
		'',
		'Acknowledge briefly that the named session is loaded, then wait for the user.',
	].join('\n');
}

export function providerCommand(
	provider: Provider,
	record: AgentRecord,
	sessionId: string | undefined,
): string[] {
	const prompt = sessionPrompt(record);
	if (provider === 'codex') {
		return sessionId
			? ['codex', 'resume', '-C', record.cwd, sessionId, prompt]
			: ['codex', '-C', record.cwd, prompt];
	}

	if (!sessionId) throw new Error('Claude sessions must have an ID before launch.');
	const common = ['--name', record.name, '--append-system-prompt', prompt];
	return latestClaudeCommand(sessionId, record.sessions.claude.length, common);
}

function latestClaudeCommand(sessionId: string, sessionCount: number, common: string[]): string[] {
	return sessionCount > 0
		? ['claude', '--resume', sessionId, ...common]
		: ['claude', '--session-id', sessionId, ...common];
}
