import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { readActivity } from './agent-activity.ts';
import { observeLaunch, providerUp } from './launch-phase.ts';
import { atomicWrite, errorCode, locked, optionalText } from './mail-files.ts';
import { currentAgent } from './mail-identity.ts';
import { deliveryStatus, runtimePath } from './mail-session.ts';
import { rememberSession, sessionIdPattern, updateAgentRecord } from './store.ts';

export async function bindSession(input: unknown): Promise<void> {
	const name = currentAgent();
	const nonce = process.env.SUMMON_NONCE ?? '';
	if (!input || typeof input !== 'object') throw new Error('Invalid session hook input.');
	const event = input as Record<string, unknown>;
	if (
		event.hook_event_name !== 'SessionStart' ||
		!['startup', 'resume', 'clear', 'compact'].includes(String(event.source)) ||
		event.agent_id
	)
		return;
	if (typeof event.session_id !== 'string' || !sessionIdPattern.test(event.session_id))
		throw new Error('Invalid session ID.');
	const id = event.session_id;
	// Hold the same lock as launch initialization through the profile save and binding publication.
	// Team Stop may kill the wrapper: persistence must finish in this verified bind consumer.
	await locked(join(runtimePath(name), 'activity.json.lock'), async () => {
		const activity = await readActivity(name);
		if (
			!activity ||
			activity.nonce !== nonce ||
			(activity.launch !== undefined && activity.launch.provider !== 'codex')
		)
			throw new Error('Session binding does not match the current launch.');
		const status = await deliveryStatus(name, nonce);
		const path = join(runtimePath(name), `${nonce}.binding`);
		const previous = await optionalText(path);
		const expected = previous ?? status.thread;
		if (event.source !== 'clear' && expected && expected !== id)
			throw new Error('Session hook does not match the resumed thread.');
		await updateAgentRecord(name, (record) => {
			if (record.provider !== 'codex')
				throw new Error('Session binding requires a registered Codex teammate.');
			rememberSession(record, id);
		});
		if (event.source === 'clear') await atomicWrite(path, id);
		else {
			try {
				await writeFile(path, id, { flag: 'wx', mode: 0o600 });
			} catch (error: unknown) {
				if (errorCode(error) !== 'EEXIST' || (await optionalText(path)) !== id) throw error;
			}
		}
	});
	if (event.source === 'clear') return;
	await observeLaunch(providerUp(name, nonce, 'codex', 'codex-session-start'));
}

function tomlBasic(value: string): string {
	return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function codexHookOverride(): string {
	const cli = resolve(import.meta.dir, 'cli.ts');
	const command = `${shellSingleQuote(process.execPath)} ${shellSingleQuote(cli)} __mail-bind`;
	const windowsScript = `& '${process.execPath.replaceAll("'", "''")}' '${cli.replaceAll("'", "''")}' __mail-bind; exit $LASTEXITCODE`;
	const commandWindows = `pwsh -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(windowsScript, 'utf16le').toString('base64')}`;
	const hook = `[{matcher="startup|resume|clear",hooks=[{type="command",command=${tomlBasic(command)},command_windows=${tomlBasic(commandWindows)}}]}]`;
	return `hooks.SessionStart=${hook}`;
}
