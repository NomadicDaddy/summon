import { randomUUID } from 'node:crypto';

import { readActivity } from './agent-activity.ts';
import { headDownActor, managedHeadDownAction } from './head-down-access.ts';
import { headDownPath, headDownView, readHeadDown, saveHeadDown } from './head-down-model.ts';
import { isHibernated } from './hibernation.ts';
import { appendLocalEvent } from './local-room.ts';
import { locked } from './mail-files.ts';
import { currentAgent } from './mail-identity.ts';
import { answerRoom, askRoom } from './room-question-access.ts';
import { slugFor } from './store.ts';

function bounded(value: string, maximum: number): string {
	if (!value.trim() || value.length > maximum || /\p{Cc}/u.test(value))
		throw new Error(`Text must contain 1–${maximum} characters and no control characters.`);
	return value.trim();
}

export async function requestHeadDown(goal: string, completion: string, assurance: boolean) {
	const name = currentAgent();
	await headDownActor();
	if (!assurance) throw new Error('Explicit --return-to-normal commitment is required.');
	goal = bounded(goal, 120);
	completion = bounded(completion, 1000);
	return locked(`${headDownPath(name)}.lock`, async () => {
		if (await headDownView(name)) throw new Error('End the existing request first.');
		if (await isHibernated(name)) throw new Error('Cannot request head-down while hibernated.');
		const nonce = process.env.SUMMON_NONCE;
		if (!nonce) throw new Error('No current launch.');
		const event = await askRoom([
			'--approval',
			`Allow ${name} to work head-down on: ${goal}? Completion condition: ${completion}. ` +
				'I commit to return to Normal when complete, blocked, cancelled, or needing a human decision. ' +
				'Notifications remain queued. No goal deadline or automatic stop is requested.',
		]);
		const state = {
			id: randomUUID(),
			nonce,
			phase: 'requested' as const,
			goal,
			completion,
			questionId: event.id,
		};
		await saveHeadDown(name, state);
		return state;
	});
}

export async function decideHeadDown(name: string, id: string, approve: boolean): Promise<void> {
	if (!process.env.SUMMON_AGENT) {
		const state = await readHeadDown(name);
		if (!state || state.id !== id || state.phase !== 'requested')
			throw new Error('Request is no longer pending.');
		if (!(await headDownView(name)))
			throw new Error('Request belongs to a stopped or previous launch.');
		await answerRoom(state.questionId, approve ? 0 : 1);
		return;
	}
	await applyHeadDownDecision(name, id, approve);
}

async function applyHeadDownDecision(name: string, id: string, approve: boolean): Promise<void> {
	const slug = slugFor(name);
	await managedHeadDownAction(slug, (actor) =>
		locked(`${headDownPath(slug)}.lock`, async () => {
			const state = await readHeadDown(slug);
			if (!state || state.id !== id || state.phase !== 'requested')
				throw new Error('Request is no longer pending.');
			if (!(await headDownView(slug)))
				throw new Error('Request belongs to a stopped or previous launch.');
			await saveHeadDown(slug, {
				...state,
				phase: approve ? 'active' : 'ended',
				approvedBy: actor,
				decision: approve ? 'approved' : 'declined',
				reason: approve ? 'Approved for this goal and launch only' : 'Declined',
			});
			await appendLocalEvent({
				sender: { kind: actor === 'operator' ? 'user' : 'agent', id: actor },
				text: `${slug}: head-down ${approve ? 'approved' : 'declined'} by ${actor}. Goal: ${state.goal}`,
				replyTo: state.questionId,
				source: 'local',
			});
		}),
	);
}

export async function endHeadDown(
	name: string,
	id: string,
	reason: string,
	steer = false,
): Promise<void> {
	const slug = slugFor(name);
	const actor = await headDownActor();
	const outcome = bounded(reason, 1000);
	if (actor === slug && !steer) await closeHeadDown(slug, id, outcome, actor);
	else
		await managedHeadDownAction(slug, (manager) =>
			closeHeadDown(slug, id, outcome, manager, steer),
		);
}

async function closeHeadDown(
	name: string,
	id: string,
	reason: string,
	actor: string,
	steer = false,
): Promise<void> {
	await locked(`${headDownPath(name)}.lock`, async () => {
		const state = await readHeadDown(name);
		if (!state || state.id !== id) throw new Error('Head-down request changed.');
		if (state.phase === 'ended') {
			if (steer)
				throw new Error(
					'Head-down has ended; use the current session to give new directions.',
				);
			return;
		}
		await saveHeadDown(name, { ...state, phase: 'ended', reason });
		const event = await appendLocalEvent({
			sender: { kind: actor === 'operator' ? 'user' : 'agent', id: actor },
			text: `${steer ? '@' : ''}${name} returned to Normal: ${steer ? 'Explicit steering: ' : ''}${reason}. Queued notifications may now be delivered.`,
			replyTo: state.questionId,
			source: 'local',
		});
		if (steer)
			await saveHeadDown(name, { ...state, phase: 'ended', reason, steeringId: event.id });
	});
}

export async function finishHeadDownLaunch(name: string, nonce?: string): Promise<void> {
	const state = await readHeadDown(name);
	if (state && state.phase !== 'ended' && (nonce === undefined || state.nonce === nonce))
		await closeHeadDown(name, state.id, nonce ? 'Session exited' : 'New session launch', name);
}

export async function answerHeadDown(
	name: string,
	questionId: number,
	approve: boolean,
): Promise<void> {
	// The owner comes from the persisted question, never from an answer supplied by a peer.
	const state = await locked(`${headDownPath(name)}.lock`, () => readHeadDown(name));
	if (state?.questionId !== questionId || state.phase !== 'requested') return;
	if ((await readActivity(name))?.nonce !== state.nonce) return;
	await applyHeadDownDecision(name, state.id, approve);
}
