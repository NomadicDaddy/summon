import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { OperatorIdentity } from './operator-identity-model.ts';

import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import {
	DEFAULT_OPERATOR_IDENTITY,
	operatorNames,
	parseOperatorIdentity,
} from './operator-identity-model.ts';
import { listAgentSlugs, loadAgent, storageRoot } from './store.ts';

export const operatorIdentityPath = () => join(storageRoot(), 'settings', 'operator-identity.json');

interface IdentityMember {
	slug: string;
	name: string;
}

function configuration(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error('Invalid operator identity JSON.');
	}
}

async function validateMembers(
	identity: OperatorIdentity,
	members?: readonly IdentityMember[],
): Promise<void> {
	const names = new Set(operatorNames(identity).map((item) => item.toLowerCase()));
	const current = members
		? new Map(members.map((member) => [member.slug, member.name]))
		: undefined;
	for (const slug of await listAgentSlugs()) {
		// Snapshot reads check visible labels plus every registry slug, without loading records
		// twice. Direct CLI/startup reads and writes also check raw name/displayName fields.
		const record = current ? undefined : await loadAgent(slug);
		for (const label of [slug, current?.get(slug), record?.name, record?.displayName]) {
			if (label && names.has(label.trim().toLowerCase()))
				throw new Error(
					`Operator identity ${JSON.stringify(label)} conflicts with registered member ${JSON.stringify(slug)}.`,
				);
		}
	}
}

/** Shared team configuration; agents may read it, only the operator may change it. */
export async function configuredOperatorIdentity(): Promise<OperatorIdentity> {
	const text = await optionalText(operatorIdentityPath());
	return text === undefined
		? structuredClone(DEFAULT_OPERATOR_IDENTITY)
		: parseOperatorIdentity(configuration(text));
}

export async function operatorIdentity(
	members?: readonly IdentityMember[],
): Promise<OperatorIdentity> {
	const identity = await configuredOperatorIdentity();
	await validateMembers(identity, members);
	return identity;
}

/** Presentation faults must not prevent every teammate's startup prompt. */
export async function startupOperatorDisplay(): Promise<string> {
	try {
		return (await operatorIdentity()).display;
	} catch {
		console.warn(
			'Operator identity unavailable: using generic Operator in startup. Inspect summon --operator-identity show; no identity or permission change was applied.',
		);
		return DEFAULT_OPERATOR_IDENTITY.display;
	}
}

export async function saveOperatorIdentity(
	value: unknown,
	createOnly = false,
): Promise<OperatorIdentity> {
	operatorOnly();
	const identity = parseOperatorIdentity(value);
	await locked(`${operatorIdentityPath()}.lock`, async () => {
		if (createOnly && (await optionalText(operatorIdentityPath())) !== undefined)
			throw new Error('Operator identity already exists; it was not replaced.');
		await validateMembers(identity);
		await atomicWrite(operatorIdentityPath(), JSON.stringify({ version: 1, ...identity }));
	});
	return identity;
}

/** Route before initializeStore: invalid settings and read-only views must not rewrite prompts. */
export async function operatorIdentityRouted(args: string[]): Promise<boolean> {
	if (args[0] !== '--operator-identity') return false;
	if (args[1] === 'show' && args.length === 2)
		console.log(JSON.stringify(await operatorIdentity()));
	else if (
		['set', 'create'].includes(args[1] ?? '') &&
		args[2] === '--file' &&
		args[3] &&
		args.length === 4
	) {
		operatorOnly();
		const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(args[3]));
		if (text.includes('\0')) throw new Error('Operator identity contains NUL.');
		console.log(
			JSON.stringify(await saveOperatorIdentity(configuration(text), args[1] === 'create')),
		);
	} else
		throw new Error(
			'Usage: summon --operator-identity show | set|create --file <UTF-8-JSON-path>',
		);
	return true;
}
