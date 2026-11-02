import { join } from 'node:path';

import { atomicWrite, optionalText } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import { listAgentSlugs, storageRoot } from './store.ts';

/**
 * How Claude teammates on this team receive mail and Room notices.
 *
 * Live delivery needs Claude's `--dangerously-load-development-channels` flag, and Claude then
 * asks for confirmation at every start. Claude skips that prompt only for channels on Anthropic's
 * approved list or under an organisation's managed policy, so Summon's own local channel cannot
 * avoid it. Checkpoint delivery omits the flag: the Team Window types notices into its owned
 * terminal, and the model reads their contents at each checkpoint. Detached sessions read at
 * startup and at checkpoints without a pushed channel.
 */
export type ClaudeDelivery = 'checkpoint' | 'live';

function configuration(): string {
	return join(storageRoot(), 'settings', 'claude-delivery.json');
}

function isDelivery(value: unknown): value is ClaudeDelivery {
	return value === 'checkpoint' || value === 'live';
}

/**
 * The team's setting. A team that predates the setting has no file and keeps the live delivery it
 * already had; a new team is given `checkpoint` explicitly when its first teammate is created, so
 * a missing file never has to stand for both.
 */
export async function claudeDelivery(): Promise<ClaudeDelivery> {
	const text = await optionalText(configuration());
	if (text === undefined) return 'live';
	const config: unknown = JSON.parse(text);
	if (
		!config ||
		typeof config !== 'object' ||
		!('version' in config) ||
		config.version !== 1 ||
		!('mode' in config) ||
		!isDelivery(config.mode)
	)
		throw new Error('Invalid Claude delivery configuration.');
	return config.mode;
}

async function write(mode: ClaudeDelivery): Promise<void> {
	await atomicWrite(configuration(), JSON.stringify({ version: 1, mode }));
}

/** Operator-only change of the team's setting; anything but the two modes is refused. */
export async function setClaudeDelivery(mode: unknown): Promise<ClaudeDelivery> {
	operatorOnly();
	if (!isDelivery(mode)) throw new Error('Invalid Claude delivery mode.');
	await write(mode);
	return mode;
}

/**
 * Gate for creating a teammate. Creation is the operator's alone, and the first teammate of an
 * empty team is the one moment a new team can be told apart from an existing one.
 */
export async function authorizeNewTeammate(): Promise<void> {
	operatorOnly();
	if ((await optionalText(configuration())) !== undefined) return;
	if ((await listAgentSlugs()).length === 0) await write('checkpoint');
}

/**
 * Whether this Claude launch asks for the channel. An explicit `--claude-mail-channel` always
 * wins, for that launch only. Otherwise a live team opts in once it has a Room or Telegram to
 * deliver from, and a checkpoint team never does.
 */
export async function claudeChannelRequested(
	explicit: boolean,
	hasRoom: boolean,
): Promise<boolean> {
	return explicit || (hasRoom && (await claudeDelivery()) === 'live');
}

/** Printed by the session wrapper immediately before Claude shows its own confirmation. */
export const CLAUDE_CHANNEL_NOTICE = [
	'Claude is about to ask whether to load a development channel named server:summon-mail.',
	"That channel is Summon's own mail and Room notifier, run from this install. Nothing is downloaded.",
	'Choose 1 for live notices. Choosing Exit closes Claude.',
	'To start Claude teammates without this prompt: summon --claude-delivery checkpoint',
].join('\n');

export const CLAUDE_CHECKPOINT_REASON =
	'claude uses checkpoint mailbox checks; the Team Window delivers terminal notices without the live channel.';

/** Shown when Claude ends before confirming readiness. An early exit is all Summon can observe. */
export const CLAUDE_EARLY_EXIT_NOTICE =
	'Claude closed before confirming launch readiness. If that was at its development-channel confirmation, summon --claude-delivery checkpoint starts Claude teammates without it.';

export async function claudeDeliveryCommand(args: string[]): Promise<void> {
	if (args.length === 0) {
		console.log(`Claude delivery: ${await claudeDelivery()}`);
		return;
	}
	const mode = args[0];
	if (args.length !== 1 || !isDelivery(mode))
		throw new Error('Usage: summon --claude-delivery [live|checkpoint]');
	await setClaudeDelivery(mode);
	console.log(
		mode === 'live'
			? 'Claude teammates will ask for live delivery at their next start; Claude shows its development-channel confirmation each time.'
			: 'Claude teammates will start without the development-channel confirmation and read mail and Room notices at startup and at each checkpoint.',
	);
}
