import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
	assertDeferredCheckpointState,
	migrateCheckpointState,
} from '../src/checkpoint-migration-model.ts';
import { offlineRuntimeCheck } from '../src/checkpoint-offline-runtime.ts';
import { checkpointConfig } from '../src/checkpoint-package-capture.ts';
import { checkpointHash } from '../src/checkpoint-package-model.ts';
import { ownHolds } from '../src/mail-attention.ts';
import { atomicWrite, locked, optionalText } from '../src/mail-files.ts';
import { operatorOnly } from '../src/mail-identity.ts';
import { localCursorPath, roomCursor } from '../src/room-cursor.ts';
import { listAgentSlugs, loadAgent, slugFor, storageRoot } from '../src/store.ts';
import { roomCursorPath } from '../src/telegram-live.ts';

type Plan = { name: string; path: string; before: string; after: string };
type Deferred = { name: string; path: string; sha256: string };

async function assertDeferrable(name: string): Promise<void> {
	const record = await loadAgent(name);
	if (record?.provider !== 'grok' || !record.hibernation?.active)
		throw new Error('Only an explicitly selected hibernated Grok owner may be deferred.');
}

async function verifyDeferred(owners: Deferred[]): Promise<void> {
	for (const owner of owners) {
		await assertDeferrable(owner.name);
		await locked(`${owner.path}.lock`, async () => {
			const raw = await optionalText(owner.path);
			if (raw === undefined || checkpointHash(raw) !== owner.sha256)
				throw new Error('Deferred checkpoint changed after preflight; migration refused.');
			assertDeferredCheckpointState(raw);
		});
	}
}

async function assertOfflineProcesses(): Promise<void> {
	if (process.platform !== 'win32')
		throw new Error('This offline migration requires the Windows operator terminal.');
	const script =
		'Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match "(?i)(dist[\\/]+team[\\/]+main|summon.*(?:__session|--team)|src[\\/]+cli\\.ts.*__session)" } | ForEach-Object { $_.ProcessId } | ConvertTo-Json -Compress';
	const child = Bun.spawn({
		cmd: ['pwsh', '-NoProfile', '-NonInteractive', '-Command', script],
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	await new Response(child.stderr).text();
	if (code !== 0)
		throw new Error('Could not verify offline process inventory; migration refused.');
	if (output.trim() && output.trim() !== 'null')
		throw new Error('A Summon window or session process is still present; migration refused.');
}

async function preflight(selected: Set<string>): Promise<{ plans: Plan[]; deferred: Deferred[] }> {
	const root = storageRoot();
	if ((await lstat(root)).isSymbolicLink())
		throw new Error('Linked storage root; migration refused.');
	const config = await checkpointConfig();
	const names = new Set(await listAgentSlugs());
	const runtime = join(root, 'runtime');
	if ((await lstat(runtime)).isSymbolicLink())
		throw new Error('Linked runtime root; migration refused.');
	const plans: Plan[] = [];
	const deferred: Deferred[] = [];
	const assertInactiveRuntime = offlineRuntimeCheck();
	for (const name of selected) {
		if (!names.has(name)) throw new Error('Unregistered deferred owner; migration refused.');
		await assertDeferrable(name);
	}
	for (const entry of await readdir(runtime, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) throw new Error('Linked runtime owner; migration refused.');
		if (!entry.isDirectory() || entry.name === 'team-window') continue;
		const folder = join(runtime, entry.name);
		await assertInactiveRuntime(folder);
		const path = join(folder, 'checkpoint.json');
		const before = await optionalText(path);
		if (before === undefined) continue;
		if (slugFor(entry.name) !== entry.name || !names.has(entry.name))
			throw new Error('Unregistered checkpoint owner; migration refused.');
		if (selected.has(entry.name)) {
			assertDeferredCheckpointState(before);
			deferred.push({ name: entry.name, path, sha256: checkpointHash(before) });
			continue;
		}
		const room = roomCursor((await optionalText(localCursorPath(entry.name))) ?? '0');
		const telegram = config
			? roomCursor((await optionalText(roomCursorPath(config, entry.name))) ?? '0')
			: undefined;
		const holds = await ownHolds(entry.name);
		let after: string;
		try {
			after = JSON.stringify(migrateCheckpointState(before, room, telegram, holds));
		} catch (error: unknown) {
			if (error instanceof Error && error.message.startsWith('Unsettled checkpoint batch;'))
				throw new Error(
					`Unsettled checkpoint batch for ${entry.name}; its owner must read and acknowledge it with the current release before shutdown. Migration refused.`,
					{ cause: error },
				);
			throw new Error(`Invalid checkpoint state for ${entry.name}; migration refused.`, {
				cause: error,
			});
		}
		plans.push({ name: entry.name, path, before, after });
	}
	if (deferred.length !== selected.size)
		throw new Error('A selected deferred owner has no legacy checkpoint state.');
	await verifyDeferred(deferred);
	return { plans, deferred };
}

operatorOnly();
const args = process.argv.slice(2);
if (
	args.length < 2 ||
	args[0] !== '--offline' ||
	!['--preflight', '--apply'].includes(args[1] ?? '')
)
	throw new Error(
		'Usage: bun scripts/migrate-checkpoints.ts --offline --preflight|--apply [--defer-owner name]. Close ALL Summon windows, sessions and receivers first.',
	);
const selected = new Set<string>();
for (let at = 2; at < args.length; at += 2) {
	const name = args[at + 1];
	if (args[at] !== '--defer-owner' || !name || slugFor(name) !== name || selected.has(name))
		throw new Error('Each --defer-owner requires a unique registered slug.');
	selected.add(name);
}
await assertOfflineProcesses();
await locked(join(storageRoot(), 'runtime', 'checkpoint-migration.lock'), async () => {
	const { plans, deferred } = await preflight(selected);
	if (args[1] === '--preflight') {
		console.log(
			JSON.stringify({
				ready: true,
				owners: plans.map((plan) => plan.name),
				deferred: deferred.map((owner) => owner.name),
				deferredUnchanged: true,
				sourceCursorsUnchanged: true,
			}),
		);
		return;
	}
	const backup = join(storageRoot(), 'runtime', 'checkpoint-migrations', randomUUID());
	await atomicWrite(join(backup, 'plan.json'), JSON.stringify(plans));
	await atomicWrite(join(backup, 'deferred.json'), JSON.stringify(deferred));
	const applied: Plan[] = [];
	try {
		await assertOfflineProcesses();
		await verifyDeferred(deferred);
		for (const plan of plans) {
			await locked(`${plan.path}.lock`, async () => {
				if ((await optionalText(plan.path)) !== plan.before)
					throw new Error('Checkpoint changed after preflight; migration refused.');
				await atomicWrite(plan.path, plan.after);
				applied.push(plan);
			});
		}
		await verifyDeferred(deferred);
		await atomicWrite(
			join(backup, 'complete.json'),
			JSON.stringify({
				owners: plans.map((plan) => plan.name),
				deferred: deferred.map((owner) => owner.name),
				digest: checkpointHash(plans),
			}),
		);
		console.log(
			JSON.stringify({
				migrated: true,
				owners: plans.map((plan) => plan.name),
				deferred: deferred.map((owner) => owner.name),
				deferredUnchanged: true,
				backup,
				sourceCursorsUnchanged: true,
			}),
		);
	} catch (error: unknown) {
		for (const plan of applied.reverse())
			await locked(`${plan.path}.lock`, async () => {
				if ((await optionalText(plan.path)) !== plan.after)
					throw new Error(
						`Migration recovery requires the operator; retained plan: ${backup}`,
					);
				await atomicWrite(plan.path, plan.before);
			});
		throw error;
	}
});
