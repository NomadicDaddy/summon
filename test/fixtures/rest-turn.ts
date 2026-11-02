import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Provider } from '../../src/store.ts';
import type { mailHarness } from './mail-harness.ts';
import type { stopHarness } from './stop-harness.ts';

import { initializeActivity } from '../../src/agent-activity.ts';
import { readRest } from '../../src/rest.ts';

export const observedProviders = ['claude', 'grok', 'kilo'] as const;

export async function readyOwnedRest(
	fixture: Awaited<ReturnType<typeof mailHarness>>,
	harness: ReturnType<typeof stopHarness>,
	name = 'alpha',
) {
	await harness.team.start(name);
	const session = harness.team.sessions.get(name);
	if (!session) throw new Error('Missing owned fixture launch.');
	const { nonce } = session.launch;
	await initializeActivity(name, nonce, session.agent.provider);
	if (session.agent.provider !== 'codex')
		await writeRestTurn(fixture.records, session.agent.provider, name, nonce, 'idle');
	const result = await fixture.run(['--rest', 'ready'], name, { SUMMON_NONCE: nonce });
	if (result.code !== 0) throw new Error(result.error);
	const state = await readRest(name);
	if (!state) throw new Error('Missing fixture rest confirmation.');
	return { nonce, id: state.id };
}

/** Persisted-schema fixture, not evidence from a native provider. */
export async function writeRestTurn(
	root: string,
	provider: Exclude<Provider, 'codex'>,
	name: string,
	nonce: string,
	phase: 'busy' | 'unknown' | 'idle',
): Promise<void> {
	const shared = { version: 1, nonce, thread: 'fixture-thread', phase, generation: 1 };
	const value =
		provider === 'claude'
			? {
					...shared,
					version: 2,
					observer: 'fixture-observer',
					epoch: 1,
					sequence: 1,
					turn: phase === 'busy' ? 'fixture-turn' : null,
					draft: false,
					attached: true,
					compactions: 0,
				}
			: provider === 'kilo'
				? {
						...shared,
						// Kilo's record is version 2 with its startup outcome (Phillip #22057).
						version: 2,
						observer: 'fixture-observer',
						busyObserved: phase === 'busy',
						bootstrapUsed: true,
						startup: 'accepted',
					}
				: { ...shared, since: Date.now(), bootstrapUsed: true };
	const directory = join(root, 'runtime', name);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, `${nonce}.${provider}-turn`), JSON.stringify(value));
}
