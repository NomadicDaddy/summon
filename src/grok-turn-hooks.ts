import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { publishGrokHook } from './grok-hook-lease.ts';
import { initializeGrokTurn } from './grok-turn-state.ts';
import { sessionStorageEnvironment } from './storage-launch.ts';

export function grokTurnHooks(name: string, nonce: string, thread: string) {
	const script = resolve(import.meta.dir, 'grok-turn-hook.ts');
	const single = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
	const windows = `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'; exit $LASTEXITCODE`;
	const command =
		process.platform === 'win32'
			? `pwsh -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(windows, 'utf16le').toString('base64')}`
			: `${single(process.execPath)} ${single(script)}`;
	const env: Record<string, string> = {
		...sessionStorageEnvironment({}),
		SUMMON_AGENT: name,
		SUMMON_NONCE: nonce,
		SUMMON_GROK_SESSION: thread,
	};
	const hook = {
		type: 'command',
		command,
		timeout: 5,
		env,
	};
	return {
		hooks: {
			UserPromptSubmit: [{ hooks: [hook] }],
			PreToolUse: [{ hooks: [hook] }],
			Notification: [{ matcher: '^idle_prompt$', hooks: [hook] }],
			PreCompact: [{ hooks: [hook] }],
			PostCompact: [{ hooks: [hook] }],
		},
	};
}

/** An exact launch owns its unique file. Existing user hooks are never overwritten or trusted. */
export async function installGrokTurnHooks(
	name: string,
	nonce: string,
	thread: string,
	home = process.env.GROK_HOME ?? join(homedir(), '.grok'),
): Promise<() => Promise<void>> {
	await initializeGrokTurn(name, nonce, thread);
	const body = `${JSON.stringify(grokTurnHooks(name, nonce, thread))}\n`;
	return publishGrokHook(name, nonce, home, body);
}
