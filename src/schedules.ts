import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

import type { ScheduleAvailability } from './schedule-deferral.ts';

import { communicationState } from './communication-state.ts';
import { isHibernated } from './hibernation.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { currentAgent, operatorOnly } from './mail-identity.ts';
import { sendMessage } from './mailbox.ts';
import { deferSchedule, scheduleDeferral } from './schedule-deferral.ts';
import { loadAgent, slugFor, storageRoot } from './store.ts';

const text = z.string().trim().min(1).max(8000);
const scheduleInput = z
	.object({
		owner: z.string().min(1),
		title: z.string().trim().min(1).max(120),
		everyMinutes: z.number().int().min(1).max(525600),
		prompt: text,
	})
	.strict();
const schedule = scheduleInput.extend({
	id: z.uuid(),
	enabled: z.boolean(),
	nextDueAt: z.number().int().nonnegative(),
	deferred: scheduleDeferral.optional(),
});
const run = z.object({
	id: z.uuid(),
	scheduleId: z.uuid(),
	owner: z.string(),
	title: z.string(),
	prompt: text,
	dueAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
	status: z.enum(['dispatching', 'delivered', 'uncertain', 'complete', 'failed']),
	result: z.string().max(8000).optional(),
});
const stateSchema = z.object({
	version: z.literal(1),
	schedules: z.array(schedule),
	runs: z.array(run),
});
type State = z.infer<typeof stateSchema>;
export type ScheduledRun = z.infer<typeof run>;

const path = (): string => join(storageRoot(), 'schedules', 'state.json');
const read = async (): Promise<State> => {
	const raw = await optionalText(path());
	return raw !== undefined
		? stateSchema.parse(JSON.parse(raw) as unknown)
		: { version: 1, schedules: [], runs: [] };
};
const save = (state: State): Promise<void> => atomicWrite(path(), JSON.stringify(state));
const finished = (item: ScheduledRun): boolean => ['complete', 'failed'].includes(item.status);

export async function listSchedules(): Promise<State> {
	const state = await read();
	if (!process.env.SUMMON_AGENT) return state;
	const owner = currentAgent();
	return {
		...state,
		schedules: state.schedules.filter((item) => item.owner === owner),
		runs: state.runs.filter((item) => item.owner === owner),
	};
}

export async function createSchedule(input: unknown): Promise<z.infer<typeof schedule>> {
	const value = scheduleInput.parse(input);
	value.owner = slugFor(value.owner);
	if (process.env.SUMMON_AGENT && currentAgent() !== value.owner)
		throw new Error('Agents may create schedules only for themselves.');
	return locked(`${path()}.lock`, async () => {
		if (!(await loadAgent(value.owner))) throw new Error('Unknown schedule owner.');
		const state = await read();
		const item = {
			...value,
			id: randomUUID(),
			enabled: true,
			nextDueAt: Date.now() + value.everyMinutes * 60000,
		};
		state.schedules.push(item);
		await save(state);
		return item;
	});
}

export async function enableSchedule(id: string, enabled: boolean): Promise<void> {
	await locked(`${path()}.lock`, async () => {
		const state = await read();
		const item = state.schedules.find((item) => item.id === id);
		if (!item) throw new Error('Unknown schedule.');
		if (process.env.SUMMON_AGENT && currentAgent() !== item.owner)
			throw new Error('Only the owner or operator may manage this schedule.');
		if (enabled && !(await loadAgent(item.owner))) throw new Error('Unknown schedule owner.');
		item.enabled = enabled;
		delete item.deferred;
		await save(state);
	});
}

/** Change future instructions only; compare and write under the dispatch/state lock. */
export async function updateSchedulePrompt(id: string, input: unknown): Promise<void> {
	const value = z
		.object({ expectedPrompt: z.string().min(1).max(8000), prompt: text })
		.strict()
		.parse(input);
	if (value.prompt.includes('\0')) throw new Error('Schedule prompt must not contain NUL.');
	z.uuid().parse(id);
	await locked(`${path()}.lock`, async () => {
		const state = await read();
		const item = state.schedules.find((item) => item.id === id);
		if (!item) throw new Error('Unknown schedule.');
		if (process.env.SUMMON_AGENT && currentAgent() !== item.owner)
			throw new Error('Only the owner or operator may manage this schedule.');
		if (item.prompt !== value.expectedPrompt)
			throw new Error('Schedule prompt changed; read it again before updating.');
		if (item.prompt === value.prompt) return;
		item.prompt = value.prompt;
		await save(state);
	});
}

/** Keep owner deletion serialized with creation, enabling, and dispatch. History remains intact. */
export async function removeScheduleOwner(
	owner: string,
	remove: () => Promise<void>,
): Promise<number> {
	operatorOnly();
	owner = slugFor(owner);
	return locked(`${path()}.lock`, async () => {
		const state = await read();
		let count = 0;
		for (const item of state.schedules) {
			if (item.owner !== owner || !item.enabled) continue;
			item.enabled = false;
			delete item.deferred;
			count++;
		}
		if (count) await save(state);
		await remove();
		return count;
	});
}

export async function finishScheduledRun(
	id: string,
	status: 'complete' | 'failed',
	result: string,
): Promise<void> {
	const evidence = text.parse(result);
	await locked(`${path()}.lock`, async () => {
		const state = await read();
		const item = state.runs.find((item) => item.id === id);
		if (!item) throw new Error('Unknown scheduled run.');
		if (process.env.SUMMON_AGENT && currentAgent() !== item.owner)
			throw new Error('Only the owner or operator may resolve this run.');
		if (finished(item)) {
			if (item.status === status && item.result === evidence) return;
			throw new Error('Run already resolved; its evidence is immutable.');
		}
		item.status = status;
		item.result = evidence;
		item.updatedAt = Date.now();
		await save(state);
	});
}

/** The window supplies its owned, running terminals. This never launches an agent. */
export async function dispatchSchedules(
	available: (owner: string) => Promise<ScheduleAvailability>,
	notify: (owner: string, runId: string) => Promise<void>,
	now = Date.now(),
): Promise<void> {
	operatorOnly();
	await locked(`${path()}.lock`, async () => {
		const state = await read();
		if ((await communicationState()).paused) {
			let changed = false;
			for (const item of state.schedules)
				if (item.enabled && item.nextDueAt <= now)
					changed = deferSchedule(item, 'communications-paused', now) || changed;
			if (changed) await save(state);
			return;
		}
		// The claim is persisted BEFORE delivery. A crash at that boundary is ambiguous, not a
		// reason to send again or mark work complete. It blocks subsequent runs until resolved.
		let changed = false;
		const problems: string[] = [];
		for (const item of state.runs)
			if (item.status === 'dispatching') {
				item.status = 'uncertain';
				item.result =
					'Delivery interrupted. Inspect the owner inbox and resolve explicitly; do not blindly repeat the work.';
				changed = true;
				problems.push(`Scheduled run ${item.id}: interrupted delivery needs inspection.`);
			}
		if (changed) await save(state);
		for (const item of state.schedules) {
			if (!item.enabled || item.nextDueAt > now) continue;
			let eligibility: ScheduleAvailability;
			if (state.runs.some((run) => run.scheduleId === item.id && !finished(run)))
				eligibility = 'unfinished-run';
			else if ((await communicationState()).paused) eligibility = 'communications-paused';
			else if (await isHibernated(item.owner)) eligibility = 'hibernated';
			else if (!(await loadAgent(item.owner))) eligibility = 'owner-missing';
			else eligibility = await available(item.owner);
			if (eligibility !== true) {
				changed = deferSchedule(item, eligibility || 'owner-unavailable', now) || changed;
				continue;
			}
			delete item.deferred;
			const pending: ScheduledRun = {
				id: randomUUID(),
				scheduleId: item.id,
				owner: item.owner,
				title: item.title,
				prompt: item.prompt,
				dueAt: item.nextDueAt,
				updatedAt: now,
				status: 'dispatching',
			};
			state.runs.push(pending);
			// Coalesce missed intervals without shifting the schedule's original phase.
			const interval = item.everyMinutes * 60000;
			item.nextDueAt += (Math.floor((now - item.nextDueAt) / interval) + 1) * interval;
			await save(state);
			try {
				await sendMessage(
					item.owner,
					item.owner,
					[
						`Named-owner schedule: ${item.title}`,
						`Run ${pending.id}. Verify its owner, prompt and status with summon --schedule run ${pending.id}.`,
						'Execute only that recorded scope. If the run is already complete or failed, do not repeat it.',
						`When finished: summon --schedule complete ${pending.id} "evidence" (or fail with the reason).`,
						'An inbox read, checkpoint receipt, or notification does not complete this run.',
					].join('\n'),
					{ id: pending.id },
				);
				pending.status = 'delivered';
				await save(state);
			} catch {
				pending.status = 'uncertain';
				pending.result =
					'Delivery failed or was interrupted. Resolve explicitly after inspection.';
				await save(state);
				problems.push(`Scheduled run ${pending.id}: uncertain delivery needs inspection.`);
				continue;
			}
			// Durable mail already exists. Notification failure must not trigger a second delivery.
			try {
				await notify(item.owner, pending.id);
			} catch {
				problems.push(
					`Scheduled run ${pending.id}: mail delivered, terminal notification failed.`,
				);
			}
		}
		if (changed) await save(state);
		if (problems.length) throw new Error(problems.join('\n'));
	});
}
