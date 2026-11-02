import { resolve } from 'node:path';

import { optionalText } from './mail-files.ts';

const names = ['summon-send', 'summon-receive', 'summon-telegram', 'summon-who'] as const;
const skillPath = (name: string): string => resolve(import.meta.dir, '../skills', name, 'SKILL.md');

export async function skillContext(): Promise<string> {
	const lines = [
		'Sidebar status: run summon --status busy "Short task" when starting work,',
		'summon --status needs-user "What you need" when waiting for the human, and',
		'summon --status idle "Available" before waiting after completion. Update when focus changes.',
		'Text is public team status (120 characters max). Status does not send mail or Telegram.',
		'Optional sidebar icon: your own <slug>.png beside your JSON record, square PNG 32–512 pixels,',
		'up to 256 KiB (128×128 recommended). Initials remain when no valid icon is supplied.',
		'Summon team skills:',
	];
	for (const name of names) {
		const path = skillPath(name);
		lines.push(
			(await optionalText(path)) === undefined
				? `Missing bundled skill ${path}; repair the summon package installation.`
				: `Read ${path} at startup and use ${name} for its workflow.`,
		);
	}
	return lines.join('\n');
}

export async function skillsCommand(args: string[]): Promise<void> {
	if (args.length !== 1 || args[0] !== 'status') {
		throw new Error(
			'Usage: summon --skills status. Skills are read directly from the package.',
		);
	}
	console.log(await skillContext());
	console.log(
		[
			'Configured Telegram enables Claude channel delivery; mail-only setups can opt in with --claude-mail-channel.',
			'This passes --dangerously-load-development-channels server:summon-mail for this launch only.',
			'Claude shows its own trust prompt; summon does not approve it or change tool permissions.',
			'Codex live delivery uses the exact resumed thread, a trusted SessionStart hook, or summon --mail bind with the supplied CODEX_THREAD_ID.',
			'Queued or unconfirmed summon --mail status means mail receipt is not proven. Use summon --telegram status for room receipt.',
			'Owned Grok/Kilo Team Window terminals use the shared receiver; Kilo ordinary notices wait for idle and a clear human draft. External terminals use startup and checkpoint reads.',
		].join('\n'),
	);
}
