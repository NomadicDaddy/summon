import { join } from 'node:path';

import { readActivity } from './agent-activity.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { currentAgent, operatorOnly } from './mail-identity.ts';
import { loadAgent, slugFor, storageRoot } from './store.ts';

const path = (): string => join(storageRoot(), 'runtime', 'head-down-delegates.json');

async function delegates(): Promise<string[]> {
	const raw = await optionalText(path());
	if (!raw) return [];
	const value: unknown = JSON.parse(raw);
	if (!Array.isArray(value) || !value.every((entry: unknown) => typeof entry === 'string'))
		throw new Error('Invalid head-down delegation record.');
	return value;
}

export async function canManageHeadDown(name: string): Promise<boolean> {
	return (await delegates()).includes(slugFor(name));
}

export async function delegateHeadDown(name: string, enabled: boolean): Promise<void> {
	operatorOnly();
	const slug = slugFor(name);
	await locked(`${path()}.lock`, async () => {
		if (!(await loadAgent(slug))) throw new Error('Agent not found.');
		const names = new Set(await delegates());
		if (enabled) names.add(slug);
		else names.delete(slug);
		await atomicWrite(path(), JSON.stringify([...names]));
	});
}

export async function removeHeadDownDelegate(
	name: string,
	remove: () => Promise<void>,
): Promise<void> {
	operatorOnly();
	await locked(`${path()}.lock`, async () => {
		const names = await delegates();
		if (names.includes(name))
			await atomicWrite(path(), JSON.stringify(names.filter((entry) => entry !== name)));
		await remove();
	});
}

export async function headDownActor(): Promise<string> {
	if (!process.env.SUMMON_AGENT) return 'operator';
	const name = currentAgent();
	if ((await readActivity(name))?.nonce !== process.env.SUMMON_NONCE)
		throw new Error('This command belongs to a previous launch.');
	return name;
}

async function requireHeadDownManager(target: string): Promise<string> {
	const actor = await headDownActor();
	if (actor !== 'operator' && (actor === slugFor(target) || !(await canManageHeadDown(actor))))
		throw new Error(
			'Only the operator or an explicitly delegated other teammate can approve or steer.',
		);
	return actor;
}

/** Serialize delegated actions with revocation and registration removal. */
export async function managedHeadDownAction(
	target: string,
	action: (actor: string) => Promise<void>,
): Promise<void> {
	await locked(`${path()}.lock`, async () => action(await requireHeadDownManager(target)));
}
