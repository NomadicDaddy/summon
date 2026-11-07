import { join } from 'node:path';
import { z } from 'zod';

import { readActivity } from './agent-activity.ts';
import { validAutoGrant } from './auto-head-down.ts';
import { atomicWrite, optionalText } from './mail-files.ts';
import { runtimePath } from './mail-session.ts';
import { processAlive } from './process-owner.ts';

export const headDownSchema = z.object({
	id: z.uuid(),
	nonce: z.string().min(1),
	phase: z.enum(['requested', 'active', 'ended']),
	goal: z.string().min(1).max(120),
	completion: z.string().min(1).max(1000),
	questionId: z.number().int().positive(),
	approvedBy: z.string().optional(),
	decision: z.enum(['approved', 'declined']).optional(),
	reason: z.string().optional(),
	steeringId: z.number().int().positive().optional(),
	recoveryPending: z.boolean().optional(),
	autoApproval: z
		.object({
			revision: z.number().int().positive(),
			settingAuditId: z.number().int().positive(),
			grantEventId: z.number().int().positive(),
		})
		.optional(),
});
export type HeadDownState = z.infer<typeof headDownSchema>;
export interface HeadDownView {
	id: string;
	phase: 'requested' | 'active';
	goal: string;
	completion: string;
	approvedBy?: string;
	heartbeatAt?: string;
	overdue: boolean;
	reason?: string;
}
const heartbeatSchema = z.object({
	nonce: z.string(),
	pid: z.number().int().positive(),
	at: z.number(),
});
export const headDownPath = (name: string): string => join(runtimePath(name), 'head-down.json');
const heartbeatPath = (name: string): string => join(runtimePath(name), 'session-heartbeat.json');

export async function readHeadDown(name: string): Promise<HeadDownState | undefined> {
	const raw = await optionalText(headDownPath(name));
	return raw === undefined ? undefined : headDownSchema.parse(JSON.parse(raw) as unknown);
}
export const saveHeadDown = (name: string, state: HeadDownState): Promise<void> =>
	atomicWrite(headDownPath(name), JSON.stringify(headDownSchema.parse(state)));

export async function sessionHeartbeat(name: string, nonce: string): Promise<void> {
	await atomicWrite(
		heartbeatPath(name),
		JSON.stringify({ nonce, pid: process.pid, at: Date.now() }),
	);
}

/** The heartbeat measures wrapper liveness, never task progress or a goal deadline. */
export async function headDownView(
	name: string,
	now = Date.now(),
): Promise<HeadDownView | undefined> {
	const state = await readHeadDown(name);
	if (!state) return undefined;
	if (state.phase === 'ended') {
		if (state.recoveryPending)
			await import('./head-down.ts')
				.then(({ flushAutoHeadDownRecovery }) => flushAutoHeadDownRecovery(name))
				.catch(() => undefined);
		return undefined;
	}
	const activity = await readActivity(name);
	if (
		state.phase === 'active' &&
		(state.autoApproval !== undefined || state.approvedBy === 'operator-setting') &&
		(activity?.nonce !== state.nonce || !(await validAutoGrant(name, state)))
	) {
		// The view fails closed even if the recovery audit cannot be written yet.
		await import('./head-down.ts')
			.then(({ recoverAutoHeadDown }) => recoverAutoHeadDown(name, state.id))
			.catch(() => undefined);
		return undefined;
	}
	if (activity?.nonce !== state.nonce) return undefined;
	const raw = await optionalText(heartbeatPath(name));
	const heartbeat = raw ? heartbeatSchema.parse(JSON.parse(raw) as unknown) : undefined;
	if (!heartbeat || heartbeat.nonce !== state.nonce || !processAlive(heartbeat.pid))
		return undefined;
	return {
		id: state.id,
		phase: state.phase,
		goal: state.goal,
		completion: state.completion,
		...(state.approvedBy ? { approvedBy: state.approvedBy } : {}),
		heartbeatAt: new Date(heartbeat.at).toISOString(),
		overdue: now - heartbeat.at > 20_000,
	};
}

export async function headDownActive(name: string): Promise<boolean> {
	return (await headDownView(name))?.phase === 'active';
}
