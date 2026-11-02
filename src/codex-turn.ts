import { dirname, join } from 'node:path';

import { readActivity } from './agent-activity.ts';
import { type CodexTurnPhase, readCodexThreadStatuses } from './codex-turn-rpc.ts';
import { optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';
import { sessionIdPattern } from './store.ts';

interface OwnedCodexLaunch {
	name: string;
	nonce: string;
}

const rosterTtl = 15_000;
const rosterCache = new Map<string, { phase: CodexTurnPhase; at: number }>();
const rosterRefreshes = new Set<string>();

function cacheKey(launch: OwnedCodexLaunch, thread: string): string {
	return `${runtimePath(launch.name)}\0${launch.nonce}\0${thread}`;
}

async function binding(launch: OwnedCodexLaunch): Promise<string | undefined> {
	ownMailbox(launch.name);
	if (!/^[a-z0-9-]+$/i.test(launch.nonce)) return;
	const activity = await readActivity(launch.name);
	if (
		activity?.nonce !== launch.nonce ||
		(activity.launch && activity.launch.provider !== 'codex')
	)
		return;
	const thread = await optionalText(join(runtimePath(launch.name), `${launch.nonce}.binding`));
	return thread && sessionIdPattern.test(thread) ? thread : undefined;
}

/** Batch only owned, current launch bindings; no title, transcript or other thread is selected. */
export async function codexTurns(
	launches: readonly OwnedCodexLaunch[],
): Promise<Map<string, CodexTurnPhase>> {
	const phases = new Map<string, CodexTurnPhase>(launches.map(({ name }) => [name, 'unknown']));
	const bound = await Promise.all(
		launches.map(async (launch) => ({
			launch,
			thread: await binding(launch).catch(() => undefined),
		})),
	);
	const threads = [...new Set(bound.flatMap(({ thread }) => (thread ? [thread] : [])))];
	const observed = await readCodexThreadStatuses(threads);
	for (const { launch, thread } of bound) {
		// A clear, relaunch or rebind during the read cannot lend its idle to the earlier launch.
		if (thread && (await binding(launch).catch(() => undefined)) === thread)
			phases.set(launch.name, observed.get(thread) ?? 'unknown');
	}
	return phases;
}

export async function codexTurn(name: string, nonce: string): Promise<CodexTurnPhase> {
	return (await codexTurns([{ name, nonce }])).get(name) ?? 'unknown';
}

/** Roster observations expire after 15 s; Stop and rest use the uncached readers above. */
export async function codexRosterTurns(
	launches: readonly OwnedCodexLaunch[],
): Promise<Map<string, CodexTurnPhase>> {
	const phases = new Map<string, CodexTurnPhase>(launches.map(({ name }) => [name, 'unknown']));
	const bound = await Promise.all(
		launches.slice(0, 64).map(async (launch) => {
			const thread = await binding(launch).catch(() => undefined);
			return { launch, thread, key: thread ? cacheKey(launch, thread) : undefined };
		}),
	);
	const now = Date.now();
	const stale = bound.filter(({ launch, key }) => {
		const cached = key ? rosterCache.get(key) : undefined;
		if (cached && now >= cached.at && now - cached.at < rosterTtl) {
			phases.set(launch.name, cached.phase);
			return false;
		}
		return key !== undefined;
	});
	const first = stale[0];
	if (!first) return phases;
	const store = dirname(runtimePath(first.launch.name));
	if (rosterRefreshes.has(store)) return phases;
	rosterRefreshes.add(store);
	// Do not await the daemon from the 2 s roster poll, including the first observation.
	void (async () => {
		const threads = [...new Set(stale.flatMap(({ thread }) => (thread ? [thread] : [])))];
		const observed = await readCodexThreadStatuses(threads).catch(
			() => new Map<string, CodexTurnPhase>(),
		);
		for (const { launch, thread, key } of stale) {
			if (
				thread &&
				key &&
				cacheKey(launch, thread) === key &&
				(await binding(launch).catch(() => undefined)) === thread
			) {
				rosterCache.set(key, { phase: observed.get(thread) ?? 'unknown', at: Date.now() });
				while (rosterCache.size > 64) {
					const oldest = rosterCache.keys().next().value;
					if (oldest === undefined) break;
					rosterCache.delete(oldest);
				}
			}
		}
	})()
		.catch(() => {})
		.finally(() => rosterRefreshes.delete(store));
	return phases;
}
