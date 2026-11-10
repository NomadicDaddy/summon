import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

import type { Provider } from './store.ts';

import { readActivity, setOwnActivity } from './agent-activity.ts';
import { isHibernated } from './hibernation.ts';
import { atomicWrite, errorCode, LockBusyError, locked, optionalText } from './mail-files.ts';
import { currentAgent, operatorOnly, ownMailbox } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';
import { restEvidence } from './rest-evidence.ts';
import { requestRestStop, requireRestStopper, restStopStatus } from './rest-stop.ts';
import { assertRestStopTurn, RestStopRefusedError } from './rest-turn.ts';
import { listAgentSlugs } from './store.ts';

const schema = z.object({
	id: z.uuid(),
	mode: z.enum(['ready', 'stopped', 'wake-requested', 'waking', 'uncertain', 'awake']),
	board: z.string(),
	through: z.number().int().nonnegative(),
	nonce: z.string(),
	resume: z.boolean(),
	wakePid: z.number().int().positive().optional(),
	reason: z.string(),
	waitingActivity: z.string().optional(),
	waitingScheduleIds: z.array(z.uuid()).optional(),
});
export type RestState = z.infer<typeof schema>;
const path = (name: string) => join(runtimePath(name), 'rest.json');
export async function readRest(name: string): Promise<RestState | undefined> {
	ownMailbox(name);
	const raw = await optionalText(path(name));
	return raw === undefined ? undefined : schema.parse(JSON.parse(raw) as unknown);
}
const save = (name: string, state: RestState) => atomicWrite(path(name), JSON.stringify(state));

export async function refreshRest(name: string): Promise<RestState | undefined> {
	ownMailbox(name);
	// Polling may skip writes, but must observe an existing confirmation lock before state.
	const held = await optionalText(`${path(name)}.lock`).catch((error: unknown) => {
		if (['EPERM', 'EBUSY', 'EACCES'].includes(errorCode(error) ?? '')) return 'uncertain';
		throw error;
	});
	if (held === undefined) {
		const current = await readRest(name);
		if (!current || !['ready', 'stopped'].includes(current.mode)) return current;
	}
	return refreshLockedRest(name);
}

async function refreshLockedRest(name: string): Promise<RestState | undefined> {
	ownMailbox(name);
	return locked(`${path(name)}.lock`, async () => {
		const state = await readRest(name);
		if (!state || !['ready', 'stopped'].includes(state.mode)) return state;
		if (await isHibernated(name)) {
			state.mode = 'awake';
			state.resume = false;
			state.reason = 'Hibernated by operator';
		} else {
			const evidence = await restEvidence(
				name,
				state.through,
				false,
				state.waitingActivity,
				state.mode === 'stopped',
				state.waitingScheduleIds,
			);
			if (evidence.nonce !== state.nonce) {
				state.mode = 'awake';
				state.resume = false;
				state.reason = 'A new launch needs its own rest confirmation';
				await save(name, state);
				return state;
			}
			const reason =
				evidence.reason ||
				(evidence.board !== state.board ? 'Your cards or approval decisions changed' : '');
			if (!reason) return state;
			state.resume = state.mode === 'stopped';
			state.mode = 'wake-requested';
			state.reason = reason;
		}
		await save(name, state);
		return state;
	});
}

export async function restSuppressed(name: string): Promise<boolean> {
	try {
		// Permission to send must serialize with confirmation; a polling snapshot is insufficient.
		const state = await refreshLockedRest(name);
		return state?.mode === 'ready' || state?.mode === 'stopped';
	} catch (error: unknown) {
		// A concurrent confirmation/stop must settle before an automatic notice can proceed.
		if (error instanceof LockBusyError) return true;
		throw error;
	}
}

export async function restCommand(args: string[]): Promise<void> {
	if (args[0] === 'stop' && args.length === 3 && args[1] && args[2]) {
		console.log(JSON.stringify(await requestRestStop(args[1], args[2])));
		return;
	}
	if (args[0] === 'stop-status' && args.length === 2 && args[1]) {
		console.log(JSON.stringify((await restStopStatus(args[1])) ?? null));
		return;
	}
	if (args[0] === 'candidates' && args.length === 1) {
		const actor = await requireRestStopper();
		const candidates: { name: string; confirmation: string }[] = [];
		for (const name of await listAgentSlugs()) {
			if (name === actor) continue;
			const raw = await optionalText(path(name));
			if (!raw) continue;
			const result = schema.safeParse(JSON.parse(raw) as unknown);
			if (result.success && result.data.mode === 'ready')
				candidates.push({ name, confirmation: result.data.id });
		}
		console.log(JSON.stringify(candidates));
		return;
	}
	const name = currentAgent();
	if (args.length !== 1 || !['ready', 'cancel', 'status'].includes(args[0] ?? ''))
		throw new Error('Usage: summon --rest ready|cancel|status');
	if (args[0] === 'status') {
		const state = await refreshRest(name);
		const currentLaunchNonce = (await readActivity(name))?.nonce || null;
		console.log(
			JSON.stringify(
				state
					? {
							...state,
							currentLaunchNonce,
							confirmationIsCurrentLaunch:
								currentLaunchNonce === null
									? null
									: state.nonce === currentLaunchNonce,
						}
					: null,
			),
		);
		return;
	}
	await locked(`${path(name)}.lock`, async () => {
		if (args[0] === 'cancel') {
			const state = await readRest(name);
			if (state) await save(name, { ...state, mode: 'awake', resume: false });
			return;
		}
		if (await isHibernated(name)) throw new Error('Hibernation takes precedence over rest.');
		// Resting is one command: every other reason is checked first, and only then is the
		// caller's own status set to idle "Ready", so a refusal leaves the status as it was. A
		// raised hand is preserved byte-for-byte and bound to this explicit confirmation instead.
		const evidence = await restEvidence(name, undefined, true);
		if (!evidence.nonce || evidence.nonce !== process.env.SUMMON_NONCE)
			throw new Error('Activity belongs to another launch.');
		if (evidence.reason) throw new Error(`Cannot confirm rest: ${evidence.reason}.`);
		// The idle write is conditional on the activity the evidence was based on: a status written
		// in between (new work, a raised hand) must survive, and rest must not rest on stale evidence.
		const priorActivity = await setOwnActivity(name, 'idle', 'Ready', (previous) =>
			JSON.stringify(previous) !== evidence.activitySnapshot
				? 'Cannot confirm rest: your status changed while rest was being checked. Run summon --rest ready again if you are still ready.'
				: previous.state === 'needs-user'
					? { preserve: true }
					: undefined,
		);
		const waitingActivity =
			priorActivity === 'needs-user' ? evidence.activitySnapshot : undefined;
		const waitingScheduleIds =
			priorActivity === 'needs-user' ? evidence.dueScheduleIds : undefined;
		const previous = await readRest(name);
		const id =
			previous?.mode === 'ready' &&
			previous.nonce === evidence.nonce &&
			previous.board === evidence.board &&
			previous.waitingActivity === waitingActivity &&
			JSON.stringify(previous.waitingScheduleIds) === JSON.stringify(waitingScheduleIds) &&
			previous.through === evidence.through
				? previous.id
				: randomUUID();
		await save(name, {
			id,
			mode: 'ready',
			board: evidence.board,
			through: evidence.through,
			nonce: evidence.nonce,
			resume: false,
			reason: '',
			...(waitingActivity === undefined ? {} : { waitingActivity }),
			...(waitingScheduleIds === undefined ? {} : { waitingScheduleIds }),
		});
	});
	console.log(
		args[0] === 'ready'
			? 'Ready to rest confirmed. The operator or a delegated teammate can stop this session.'
			: 'Rest confirmation cancelled.',
	);
}

/** Revalidate the exact confirmation shown in the UI before invoking the ordinary stop action. */
export async function stopForRest(
	name: string,
	id: string,
	stop: (nonce: string) => Promise<void>,
	provider: Provider,
): Promise<void> {
	operatorOnly();
	await refreshRest(name);
	await locked(`${path(name)}.lock`, async () => {
		const state = await readRest(name);
		if (state?.mode !== 'ready' || state.id !== id)
			throw new Error('Rest confirmation changed; refresh the roster.');
		const evidence = await restEvidence(
			name,
			state.through,
			false,
			state.waitingActivity,
			false,
			state.waitingScheduleIds,
		);
		if (
			(await isHibernated(name)) ||
			evidence.reason ||
			evidence.board !== state.board ||
			evidence.nonce !== state.nonce
		)
			throw new Error('New work or hibernation invalidated rest confirmation.');
		await assertRestStopTurn(provider, name, state.nonce);
		try {
			await stop(state.nonce);
		} catch (error: unknown) {
			if (error instanceof RestStopRefusedError) throw error;
			await save(name, {
				...state,
				mode: 'uncertain',
				resume: false,
				reason: 'Stop failed; inspect the session before confirming rest again.',
			});
			throw error;
		}
		await save(name, { ...state, mode: 'stopped', resume: true });
	});
}

export async function claimRestWake(name: string, id: string): Promise<RestState | undefined> {
	operatorOnly();
	return locked(`${path(name)}.lock`, async () => {
		const state = await readRest(name);
		if (state?.mode !== 'wake-requested' || state.id !== id || (await isHibernated(name)))
			return;
		await save(name, { ...state, mode: 'waking', wakePid: process.pid });
		return state;
	});
}

export async function finishRestWake(name: string, id: string, failure?: string): Promise<void> {
	operatorOnly();
	await locked(`${path(name)}.lock`, async () => {
		const state = await readRest(name);
		if (state?.id !== id || state.mode !== 'waking') return;
		await save(name, {
			...state,
			mode: failure ? 'uncertain' : 'awake',
			resume: false,
			reason: failure ?? state.reason,
		});
	});
}
