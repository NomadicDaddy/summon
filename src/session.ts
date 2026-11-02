import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { AgentRecord } from './store.ts';

import { initializeActivity } from './agent-activity.ts';
import { claudeEnvironment } from './claude-config.ts';
import {
	CLAUDE_CHANNEL_NOTICE,
	CLAUDE_CHECKPOINT_REASON,
	CLAUDE_EARLY_EXIT_NOTICE,
	claudeChannelRequested,
	type ClaudeDelivery,
} from './claude-delivery.ts';
import { startClaudeTurnBridge } from './claude-turn-bridge.ts';
import { waitForCodexBinding } from './codex-mail-delivery.ts';
import { executableCommand } from './executable.ts';
import { installGrokTurnHooks } from './grok-turn-hooks.ts';
import { startSessionHeartbeat } from './head-down-lifecycle.ts';
import { assertAwake } from './hibernation.ts';
import { kiloAgentVariant, kiloEnvironment, kiloInstructions } from './kilo-config.ts';
import { createKiloSession } from './kilo-session.ts';
import { kiloStartup } from './kilo-startup.ts';
import { observeLaunch, providerStarting } from './launch-phase.ts';
import { atomicWrite, optionalText } from './mail-files.ts';
import { codexHookOverride } from './mail-session-hook.ts';
import { runtimePath, saveDelivery } from './mail-session.ts';
import { mailboxPrompt } from './mailbox.ts';
import { providerCommand, sessionPrompt } from './providers.ts';
import { acquireSessionLock, alreadyRunning, type SessionLock } from './session-lock.ts';
import { skillContext } from './skills.ts';
import {
	forgetSession,
	latestSession,
	listAgentDomains,
	loadAgent,
	readNotes,
	rememberSession,
	sessionIdPattern,
	storageRoot,
	updateAgentRecord,
} from './store.ts';
import { assertNonElevated } from './windows-integrity.ts';

export async function runSession(
	slug: string,
	claudeMode?: ClaudeDelivery,
	launchNonce?: string,
): Promise<number> {
	await assertNonElevated();
	await assertAwake(slug);
	const lock = await acquireSessionLock(slug);
	if (!lock) {
		alreadyRunning(slug);
		return 0;
	}
	try {
		return await runLockedSession(slug, claudeMode, lock, launchNonce);
	} finally {
		await lock.release();
	}
}

function liveArgsFor(
	record: AgentRecord,
	slug: string,
	nonce: string,
	enableClaudeChannel: boolean,
): string[] {
	return record.provider === 'codex'
		? ['--add-dir', resolve(storageRoot()), '-c', codexHookOverride()]
		: record.provider === 'claude'
			? [
					'--mcp-config',
					JSON.stringify({
						mcpServers: {
							'summon-mail': {
								command: process.execPath,
								args: [resolve(import.meta.dir, 'claude-mail-channel.ts')],
								env: {
									SUMMON_HOME: resolve(storageRoot()),
									SUMMON_TEAMS_HOME: process.env.SUMMON_TEAMS_HOME,
									SUMMON_AGENT: slug,
									SUMMON_NONCE: nonce,
									SUMMON_CLAUDE_CHANNEL: enableClaudeChannel ? '1' : '0',
								},
							},
						},
					}),
					...(enableClaudeChannel
						? ['--dangerously-load-development-channels', 'server:summon-mail']
						: []),
				]
			: [];
}

async function runLockedSession(
	slug: string,
	claudeMode: ClaudeDelivery | undefined,
	lock: SessionLock,
	launchNonce?: string,
): Promise<number> {
	const record = await loadAgent(slug);
	await assertAwake(slug);
	if (!record) throw new Error(`No stored agent named ${slug}.`);
	if (claudeMode && record.provider !== 'claude')
		throw new Error('--claude-mail-channel requires a Claude agent.');
	const hasRoom =
		(await Bun.file(resolve(storageRoot(), 'integrations', 'telegram.json')).exists()) ||
		(await Bun.file(resolve(storageRoot(), 'room', 'events.json')).exists());
	const enableClaudeChannel =
		record.provider === 'claude' &&
		claudeMode !== 'checkpoint' &&
		(await claudeChannelRequested(claudeMode === 'live', hasRoom));

	const existing = latestSession(record);
	const nonce = launchNonce ?? randomUUID();
	await initializeActivity(slug, nonce, launchNonce === undefined ? undefined : record.provider);
	let providerEnv =
		record.provider === 'kilo'
			? kiloAgentVariant(
					kiloEnvironment(record.model, record.lmStudioUrl),
					record.model,
					record.variant,
				)
			: claudeEnvironment(record);
	const sessionId =
		existing?.id ??
		(record.provider === 'kilo'
			? await createKiloSession(record.cwd, providerEnv, (pid) => lock.setChild(pid))
			: record.provider === 'codex'
				? undefined
				: randomUUID());
	await saveDelivery(slug, {
		nonce,
		pid: process.pid,
		state: 'queued-only',
		reason:
			record.provider === 'grok' || record.provider === 'kilo'
				? `${record.provider} awaits a Team Window-owned receiver; external terminals use startup and checkpoint reads.`
				: record.provider === 'claude' && !enableClaudeChannel
					? CLAUDE_CHECKPOINT_REASON
					: 'Waiting for provider transport and trust.',
		thread: sessionId ?? '',
	});
	const liveArgs = liveArgsFor(record, slug, nonce, enableClaudeChannel);
	// Read at launch rather than stored, so a name that gains or changes a domain is reflected in
	// the next session every other name opens.
	const notes = await readNotes(slug);
	const roster = await listAgentDomains(slug);
	const mailbox = `${await mailboxPrompt(slug)}\n\n${await skillContext()}${record.provider === 'codex' ? '\nCodex live delivery: run summon --mail bind at startup to bind the thread ID supplied by Codex. Never invent or override that ID.' : ''}`;
	const promptFile = resolve(runtimePath(slug), 'session-prompt.md');
	const launchMode = existing ? 'resume' : 'fresh';
	if (record.provider !== 'kilo')
		await atomicWrite(
			promptFile,
			sessionPrompt(record, slug, notes, roster, mailbox, launchMode, nonce),
		);
	if (record.provider === 'kilo')
		providerEnv = await kiloInstructions(
			providerEnv,
			resolve(runtimePath(slug), 'kilo-instructions.md'),
			sessionPrompt(record, slug, notes, roster, mailbox, launchMode, nonce),
		);
	const startup =
		record.provider === 'kilo' && sessionId
			? await kiloStartup(
					record.cwd,
					sessionId,
					record.model,
					{ name: slug, nonce },
					record.variant,
				)
			: undefined;
	if (sessionId) {
		await updateAgentRecord(slug, (current) => rememberSession(current, sessionId));
	}

	let stopHeartbeat: (() => Promise<void>) | undefined;
	let cleanup: (() => Promise<void>) | undefined;
	let removeTurnHooks: (() => Promise<void>) | undefined;
	let claudeBridge: Awaited<ReturnType<typeof startClaudeTurnBridge>> | undefined;
	try {
		if (record.provider === 'claude' && sessionId) {
			try {
				claudeBridge = await startClaudeTurnBridge(slug, nonce, sessionId);
			} catch {
				console.error(
					'Claude native observation unavailable; ordinary notices remain queued. Use checkpoints.',
				);
			}
		}
		const command = providerCommand(
			record,
			slug,
			sessionId,
			notes,
			roster,
			mailbox,
			[...liveArgs, ...(startup?.args ?? []), ...(claudeBridge?.args ?? [])],
			promptFile,
		);
		if (record.provider === 'grok' && launchNonce !== undefined && sessionId) {
			try {
				removeTurnHooks = await installGrokTurnHooks(slug, nonce, sessionId);
			} catch (error: unknown) {
				console.error(
					`${slug}: Grok turn hooks unavailable: ${error instanceof Error ? error.message : 'unknown failure'}. Inspect ${runtimePath(slug)}/grok-hook-lease.json; ordinary notices remain queued. Use checkpoints.`,
				);
			}
		}
		if (enableClaudeChannel) console.log(CLAUDE_CHANNEL_NOTICE);
		stopHeartbeat = await startSessionHeartbeat(slug, nonce);
		cleanup =
			record.provider === 'codex'
				? waitForCodexBinding(slug, nonce, existing?.id)
				: undefined;
		await observeLaunch(providerStarting(slug, nonce, sessionId));
		const child = Bun.spawn({
			cmd: executableCommand(command),
			cwd: record.cwd,
			env: {
				...providerEnv,
				...startup?.env,
				...claudeBridge?.env,
				AIDD_AGENT: '1',
				SUMMON_HOME: resolve(storageRoot()),
				SUMMON_AGENT: slug,
				SUMMON_NONCE: nonce,
			},
			stdin: 'inherit',
			stdout: 'inherit',
			stderr: 'inherit',
		});
		try {
			await lock.setChild(child.pid);
		} catch (error: unknown) {
			child.kill();
			await child.exited;
			throw error;
		}
		const abortStartup = new AbortController();
		const started = startup?.start(abortStartup.signal).catch(() => {
			if (!abortStartup.signal.aborted)
				console.error(
					'Kilo startup delivery was not confirmed. It was not retried; check the session before sending another message.',
				);
		});
		const exitCode = await child.exited;
		abortStartup.abort();
		await started;
		const ready = await optionalText(resolve(runtimePath(slug), `${nonce}.ready`));
		if (record.provider === 'claude' && ready !== nonce) {
			console.error(
				enableClaudeChannel
					? CLAUDE_EARLY_EXIT_NOTICE
					: 'Claude closed before confirming launch readiness.',
			);
			// Either workspace trust or channel confirmation can exit normally before startup.
			// A new conversation is unconfirmed; do not try to resume it next time.
			if (!existing && sessionId)
				await updateAgentRecord(slug, (current) => forgetSession(current, sessionId));
		}
		if (record.provider === 'codex' && !existing) {
			const discovered = await optionalText(resolve(runtimePath(slug), `${nonce}.binding`));
			if (!discovered || !sessionIdPattern.test(discovered)) {
				console.error(
					discovered
						? 'Codex session ID was not a plain provider identifier; it was not saved.'
						: 'Codex exited without an exact launch binding; no conversation was saved. Start again and complete mailbox binding before exiting.',
				);
			}
		}
		return exitCode;
	} catch (error: unknown) {
		if (!existing && sessionId) {
			await updateAgentRecord(slug, (current) => forgetSession(current, sessionId));
		}
		throw error;
	} finally {
		try {
			await stopHeartbeat?.();
		} finally {
			try {
				await cleanup?.();
			} finally {
				try {
					await removeTurnHooks?.();
				} finally {
					await claudeBridge?.stop();
				}
			}
		}
	}
}
