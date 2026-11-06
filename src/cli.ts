#!/usr/bin/env bun

import { resolve } from 'node:path';

import type { AgentRecord } from './store.ts';

import { activityCommand, assertActiveSeat } from './agent-activity.ts';
import { beforeStoreCommand } from './before-store-command.ts';
import { boardCommand } from './board-command.ts';
import { checkpointCommand } from './checkpoint-command.ts';
import { claimsCommand } from './claims.ts';
import { claudeDeliveryCommand } from './claude-delivery.ts';
import { HELP, parseOptions } from './cli-options.ts';
import { cloneCommand } from './clone.ts';
import { communicationCommand } from './communication-state.ts';
import { diaryCommand } from './diary-command.ts';
import { headDownCommand } from './head-down-command.ts';
import { assertAwake, setHibernation } from './hibernation.ts';
import { initializeStore } from './init.ts';
import { validKiloOptions } from './kilo-config.ts';
import { checkCliKiloVariant } from './kilo-variant-check.ts';
import { applyKiloVariant } from './kilo-variant.ts';
import { ownedLaunchNonce } from './launch-phase-command.ts';
import { sendCliMessage } from './local-room-access.ts';
import { localRoomCommand } from './local-room-command.ts';
import { attentionCommand } from './mail-attention.ts';
import { operatorOnly } from './mail-identity.ts';
import { bindSession } from './mail-session-hook.ts';
import { mailCommand } from './mailbox-commands.ts';
import { notesCommand } from './notes-command.ts';
import { preparePm } from './pm-command.ts';
import { registrationCommand, routedTextEdit } from './registration-text.ts';
import { confirmRegistration, listAgents } from './registration.ts';
import { removeAgent } from './remove.ts';
import { restCommand } from './rest.ts';
import { scheduleCommand } from './schedule-command.ts';
import { acquireSessionLock, alreadyRunning, isAgentRunning } from './session-lock.ts';
import { runSession } from './session.ts';
import { skillsCommand } from './skills.ts';
import { configureStorage } from './storage-startup.ts';
import {
	appendNote,
	loadAgent,
	newRecord,
	saveAgent,
	slugFor,
	updateAgentRecord,
} from './store.ts';
import { summonAllAgents } from './summon-all.ts';
import { openTeam } from './team-window.ts';
import { telegramCommand } from './telegram.ts';
import { assertDirectory, openTerminal, terminalCommand } from './terminal.ts';
import { unownedCommand } from './unowned-command.ts';
import { assertNonElevated } from './windows-integrity.ts';

async function main(args: string[]): Promise<void> {
	if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1';
	args = await configureStorage(args);
	await assertActiveSeat();
	if (args[0] === '--unowned') {
		await unownedCommand(args.slice(1));
		return;
	}
	if (await beforeStoreCommand(args)) return;
	if (args[0] === '--team') await assertNonElevated();
	await initializeStore();
	if (!args[0]?.startsWith('__') && (args.includes('--help') || args.includes('-h'))) {
		console.log(HELP);
		return;
	}
	if (args[0] === '--notes') {
		await notesCommand(args.slice(1));
		return;
	}
	if (args[0] === '--registration') {
		await registrationCommand(args.slice(1));
		return;
	}
	if (args[0] === '--claude-delivery') {
		await claudeDeliveryCommand(args.slice(1));
		return;
	}
	if (args[0] === '--pm') {
		await main([await preparePm(args.slice(1))]);
		return;
	}
	if (args[0] === '--head-down') {
		await headDownCommand(args.slice(1));
		return;
	}
	if (args[0] === '--rest') {
		await restCommand(args.slice(1));
		return;
	}
	if (args[0] === '--schedule') {
		await scheduleCommand(args.slice(1));
		return;
	}
	if (args[0] === '--hibernate' || args[0] === '--unhibernate') {
		if (args.length !== 2 || !args[1])
			throw new Error('Usage: summon --hibernate <name> | --unhibernate <name>');
		await setHibernation(args[1], args[0] === '--hibernate');
		console.log(`${args[1]} ${args[0] === '--hibernate' ? 'hibernated' : 'unhibernated'}.`);
		if (args[0] === '--unhibernate') await main([args[1]]);
		return;
	}
	if (args[0] === '--board') {
		await boardCommand(args.slice(1));
		return;
	}
	if (args[0] === '--diary') {
		await diaryCommand(args.slice(1));
		return;
	}
	if (args[0] === '--verify-claims' || args[0] === '--claims-report') {
		await claimsCommand(args.slice(1), args[0] === '--claims-report');
		return;
	}
	if (args[0] === '--checkpoint') {
		await checkpointCommand(args.slice(1));
		return;
	}
	if (args[0] === '--msg') {
		if (args.length !== 2 || args[1] === undefined)
			throw new Error('Usage: summon --msg <text>');
		const message = await sendCliMessage(args[1]);
		console.log(`CLI message posted to Team Room #${message.id}.`);
		return;
	}
	if (args[0] === '--status') {
		await activityCommand(args.slice(1));
		return;
	}
	if (args[0] === '--room') {
		await localRoomCommand(args.slice(1));
		return;
	}
	if (args[0] === '--comms') {
		await communicationCommand(args.slice(1));
		return;
	}
	if (args[0] === '--telegram') {
		await telegramCommand(args.slice(1));
		return;
	}
	if (args[0] === '__mail-bind' && args.length === 1) {
		await bindSession(JSON.parse(await Bun.stdin.text()) as unknown);
		return;
	}
	if (args[0] === '--skills') {
		await skillsCommand(args.slice(1));
		return;
	}
	if (args[0] === '--attention') {
		await attentionCommand(args.slice(1));
		return;
	}
	if (args[0] === '--mail') {
		await mailCommand(args.slice(1));
		return;
	}
	if (args[0] === '__session') {
		const slug = args[1];
		const launch = ownedLaunchNonce(args);
		args = launch.args;
		const claudeMailChannel = args.length === 3 && args[2] === '--claude-mail-channel';
		const claudeCheckpoint = args.length === 3 && args[2] === '--claude-checkpoint';
		if (!slug || (args.length !== 2 && !claudeMailChannel && !claudeCheckpoint))
			throw new Error('Invalid internal session command.');
		process.exitCode = await runSession(
			slugFor(slug),
			claudeMailChannel ? 'live' : claudeCheckpoint ? 'checkpoint' : undefined,
			launch.nonce,
		);
		return;
	}
	if (args[0] === '--team') {
		await openTeam();
		return;
	}

	if (args[0] === '--remove') {
		if (args.length !== 2 || !args[1]) throw new Error('Usage: summon --remove <name>');
		await removeAgent(args[1]);
		return;
	}
	if (args[0]?.toLowerCase() === 'clone') {
		const created = await cloneCommand(args.slice(1));
		console.log(
			`Cloned to ${created.slug} on ${created.provider}. Sessions were not copied. Domain authority was not copied.`,
		);
		return;
	}
	if (args[0]?.toLowerCase() === 'list') {
		if (args.length !== 1) throw new Error('Usage: summon list');
		await listAgents();
		return;
	}
	if (args[0]?.toLowerCase() === 'all') {
		const newWindow = args.length === 2 && args[1] === '--new-window';
		if (args.length !== 1 && !newWindow) throw new Error('Usage: summon all [--new-window]');
		await summonAllAgents(newWindow);
		return;
	}

	const options = parseOptions(args);
	const slug = slugFor(options.name);
	const existing = await loadAgent(slug);
	if (!existing) operatorOnly();
	if (await routedTextEdit(slug, existing !== undefined, options)) return;
	if (existing) await assertAwake(slug);
	if (existing && (await isAgentRunning(slug))) {
		alreadyRunning(existing.name);
		return;
	}
	if (existing && options.provider && options.provider !== existing.provider) {
		throw new Error(
			`${existing.name} is registered with ${existing.provider}. Omit --using, or register a different name for ${options.provider}.`,
		);
	}
	const cwd = options.cwd ? resolve(options.cwd) : (existing?.cwd ?? process.cwd());
	await assertDirectory(cwd);

	let record = existing ?? newRecord(options.name, cwd, options.provider ?? 'claude');
	if (
		!validKiloOptions(
			record.provider,
			options.model ?? record.model,
			options.lmStudioUrl ?? record.lmStudioUrl,
		)
	)
		throw new Error(
			'Model options require Kilo; LM Studio URL requires an lmstudio/model and an HTTP(S) URL without credentials.',
		);
	const variant = options.variant === 'default' ? '' : options.variant;
	await checkCliKiloVariant(record, options.model, variant);
	if (options.claudeMailChannel && record.provider !== 'claude')
		throw new Error('--claude-mail-channel requires a Claude agent.');
	if (!existing && !(await confirmRegistration(options.name))) {
		console.log('Cancelled. No agent created.');
		return;
	}
	const editLock = await acquireSessionLock(slug);
	if (!editLock) {
		alreadyRunning(record.name);
		return;
	}
	try {
		const current = await loadAgent(slug);
		if (!existing && current)
			throw new Error(
				`Agent ${options.name} was registered while waiting. Run summon again.`,
			);
		if (existing && (!current || current.provider !== existing.provider))
			throw new Error('Agent registration changed. Run summon again.');
		const edit = (latest: AgentRecord): void => {
			if (latest.provider !== record.provider) throw new Error('Agent registration changed.');
			latest.cwd = options.cwd ? cwd : latest.cwd;
			if (options.model !== undefined) latest.model = options.model;
			applyKiloVariant(latest, variant);
			if (options.lmStudioUrl !== undefined) latest.lmStudioUrl = options.lmStudioUrl;
			if (!validKiloOptions(latest.provider, latest.model, latest.lmStudioUrl))
				throw new Error(
					'Provider settings changed during registration. Check model and URL.',
				);
			if (options.domain !== undefined) latest.domain = options.domain;
			if (options.expertise !== undefined) latest.expertise = options.expertise;
			record = latest;
		};
		if (existing) await updateAgentRecord(slug, edit);
		else {
			edit(record);
			await saveAgent(slug, record, true);
		}
		for (const note of options.notes) await appendNote(slug, note);
	} finally {
		await editLock.release();
	}

	if (options.sameWindow) {
		process.exitCode = await runSession(slug, options.claudeMailChannel ? 'live' : undefined);
		return;
	}

	const command = terminalCommand(
		import.meta.path,
		slug,
		record.provider,
		record.cwd,
		options.claudeMailChannel,
		options.newWindow,
	);
	if (!command) {
		console.warn('No supported terminal launcher found; opening the session here.');
		process.exitCode = await runSession(slug, options.claudeMailChannel ? 'live' : undefined);
		return;
	}
	await openTerminal(command);
	console.log(`Summoned ${record.name} with ${record.provider}.`);
}

await main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
