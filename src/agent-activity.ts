import { join } from 'node:path';

import type { LaunchPhase } from './launch-phase-model.ts';
import type { Provider } from './store.ts';

import { launchPhaseSchema } from './launch-phase-model.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { currentAgent, ownMailbox } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';

export interface AgentActivity {
	launch?: LaunchPhase;
	workingOn: string;
	state: 'idle' | 'busy' | 'needs-user';
	updatedAt: string;
	nonce: string;
}
const pathFor = (name: string): string => join(runtimePath(name), 'activity.json');

export async function readActivity(name: string): Promise<AgentActivity | undefined> {
	const text = await optionalText(pathFor(name));
	if (!text) return undefined;
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== 'object') throw new Error('Invalid agent activity.');
	const record = value as Record<string, unknown>;
	if (
		typeof record.workingOn !== 'string' ||
		record.workingOn.length > 120 ||
		!['idle', 'busy', 'needs-user'].includes(String(record.state)) ||
		typeof record.updatedAt !== 'string' ||
		typeof record.nonce !== 'string'
	)
		throw new Error('Invalid agent activity.');
	if (record.launch !== undefined) launchPhaseSchema.parse(record.launch);
	return value as AgentActivity;
}

/** Refuse commands from a named seat after its recorded launch has been replaced. */
export async function assertActiveSeat(): Promise<void> {
	if (!process.env.SUMMON_AGENT) return;
	const name = currentAgent();
	const activity = await readActivity(name);
	if (!activity || activity.nonce !== process.env.SUMMON_NONCE)
		throw new Error(
			'Activity belongs to another launch. Restart this session to enable commands.',
		);
}

/** Serialize an agent publication with launch replacement at the actual write boundary. */
export async function withActiveSeatWrite<T>(write: () => Promise<T>): Promise<T> {
	if (!process.env.SUMMON_AGENT) return write();
	const name = currentAgent();
	return locked(`${pathFor(name)}.lock`, async () => {
		await assertActiveSeat();
		return write();
	});
}

export async function initializeActivity(
	name: string,
	nonce: string,
	provider?: Provider,
): Promise<void> {
	ownMailbox(name);
	await locked(`${pathFor(name)}.lock`, () =>
		atomicWrite(
			pathFor(name),
			JSON.stringify({
				...(provider === undefined
					? {}
					: {
							launch: {
								phase: 'connecting',
								since: new Date().toISOString(),
								evidence: 'owned-process-spawn',
								provider,
							},
						}),
				workingOn: '',
				state: 'idle',
				updatedAt: new Date().toISOString(),
				nonce,
			}),
		),
	);
}

/**
 * Sets the caller's own status for the current launch. `keep` is checked against the recorded
 * state under the same lock. A string refuses the write; { preserve: true } keeps the exact
 * recorded bytes after launch validation; undefined writes the requested status.
 * @returns The state recorded before the change.
 */
export async function setOwnActivity(
	name: string,
	state: AgentActivity['state'],
	text: string,
	keep: (previous: AgentActivity) => string | { preserve: true } | undefined = () => undefined,
): Promise<AgentActivity['state']> {
	return locked(`${pathFor(name)}.lock`, async () => {
		const previous = await readActivity(name);
		if (!previous || previous.nonce !== process.env.SUMMON_NONCE)
			throw new Error(
				'Activity belongs to another launch. Restart this session to enable status.',
			);
		const refusal = keep(previous);
		if (typeof refusal === 'string' && refusal) throw new Error(refusal);
		if (typeof refusal === 'object') return previous.state;
		const next = {
			...previous,
			state,
			workingOn: text.trim(),
			updatedAt: new Date().toISOString(),
		};
		delete next.launch;
		await atomicWrite(pathFor(name), JSON.stringify(next));
		return previous.state;
	});
}

export async function activityCommand(args: string[]): Promise<void> {
	const name = currentAgent();
	const [state, text] = args;
	if (
		args.length !== 2 ||
		!['idle', 'busy', 'needs-user'].includes(state ?? '') ||
		text === undefined ||
		text.length > 120 ||
		/\p{Cc}/u.test(text)
	)
		throw new Error(
			'Usage: summon --status idle|busy|needs-user "Working On (up to 120 characters)"',
		);
	await setOwnActivity(name, state as AgentActivity['state'], text);
	console.log('Status updated.');
}
