import { join } from 'node:path';

import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import { loadAgent, slugFor, storageRoot } from './store.ts';

interface RoomWakePolicy {
	version: 1;
	routineRecipients: string[];
}

const policyPath = () => join(storageRoot(), 'settings', 'room-wake.json');

function recipients(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 64)
		throw new Error('Routine Room recipients must be an array of at most 64 registrations.');
	const names = value.map((name: unknown) => {
		if (typeof name !== 'string' || slugFor(name) !== name)
			throw new Error('Routine Room recipients must use canonical registration identifiers.');
		return name;
	});
	if (new Set(names).size !== names.length) throw new Error('Duplicate routine Room recipient.');
	return names;
}

/** Shared team policy, not a member's private runtime. No file means addressed traffic only. */
export async function roomWakePolicy(): Promise<RoomWakePolicy> {
	const text = await optionalText(policyPath());
	if (text === undefined) return { version: 1, routineRecipients: [] };
	const value: unknown = JSON.parse(text);
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		!('version' in value) ||
		value.version !== 1 ||
		!('routineRecipients' in value) ||
		Object.keys(value).some((key) => !['version', 'routineRecipients'].includes(key))
	)
		throw new Error('Invalid Room wake policy.');
	return { version: 1, routineRecipients: recipients(value.routineRecipients) };
}

/** Selection grants notices only: it confers no PM role, work approval or lifecycle authority. */
export async function receivesRoutineRoom(name: string): Promise<boolean> {
	return (await roomWakePolicy()).routineRecipients.includes(slugFor(name));
}

export async function saveRoomWakePolicy(value: unknown): Promise<RoomWakePolicy> {
	operatorOnly();
	const names = recipients(value);
	for (const name of names)
		if (!(await loadAgent(name))) throw new Error(`Unknown routine Room recipient: ${name}`);
	const policy: RoomWakePolicy = { version: 1, routineRecipients: names };
	await locked(`${policyPath()}.lock`, () => atomicWrite(policyPath(), JSON.stringify(policy)));
	return policy;
}

async function roomWakePolicyCommand(args: string[]): Promise<void> {
	const [command, ...names] = args;
	if (command === 'show' && names.length === 0)
		console.log(JSON.stringify(await roomWakePolicy()));
	else if (command === 'set' && names.length > 0)
		console.log(JSON.stringify(await saveRoomWakePolicy(names)));
	else if (command === 'clear' && names.length === 0)
		console.log(JSON.stringify(await saveRoomWakePolicy([])));
	else throw new Error('Usage: summon --room wake-policy show | set <registration>... | clear');
}

/** Route before startup-instruction generation, including writes and refusals. */
export async function roomWakePolicyRouted(args: string[]): Promise<boolean> {
	if (args[0] !== '--room' || args[1] !== 'wake-policy') return false;
	await roomWakePolicyCommand(args.slice(2));
	return true;
}
