import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { readActivity } from './agent-activity.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { currentAgent, operatorOnly } from './mail-identity.ts';
import { listAgentSlugs, loadAgent, recordPath, slugFor, storageRoot } from './store.ts';

interface StopRequest {
	id: string;
	actor: string;
	nonce: string;
	confirmation: string;
	state: 'pending' | 'done' | 'failed';
	detail: string;
}
const requestPath = (name: string): string =>
	join(storageRoot(), 'runtime', slugFor(name), 'rest-stop-request.json');

export async function requireRestStopper(): Promise<string> {
	if (!process.env.SUMMON_AGENT) return 'operator';
	const actor = currentAgent();
	await validateActor(actor, process.env.SUMMON_NONCE ?? '');
	return actor;
}

async function validateActor(actor: string, nonce: string): Promise<void> {
	if (actor === 'operator') return;
	if (!(await loadAgent(actor))?.canStopResting)
		throw new Error(
			'Only the operator or a teammate granted rest-stop permission may stop ready teammates.',
		);
	if (!nonce || (await readActivity(actor))?.nonce !== nonce)
		throw new Error('Rest-stop request belongs to another launch.');
}

async function readRequest(name: string): Promise<StopRequest | undefined> {
	const raw = await optionalText(requestPath(name));
	if (!raw) return;
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== 'object') throw new Error('Invalid rest-stop request.');
	const value = parsed as Partial<StopRequest>;
	if (
		typeof value.id !== 'string' ||
		typeof value.actor !== 'string' ||
		typeof value.nonce !== 'string' ||
		typeof value.confirmation !== 'string' ||
		!['pending', 'done', 'failed'].includes(value.state ?? '') ||
		typeof value.detail !== 'string'
	)
		throw new Error('Invalid rest-stop request.');
	if (value.actor !== 'operator') slugFor(value.actor);
	return value as StopRequest;
}

export async function requestRestStop(name: string, confirmation: string): Promise<StopRequest> {
	const target = slugFor(name);
	const actor = await requireRestStopper();
	if (actor === target) throw new Error('Delegated rest stop is only for another teammate.');
	if (!(await loadAgent(target))) throw new Error('Teammate not found.');
	if (!/^[a-f0-9-]{36}$/.test(confirmation))
		throw new Error('Use the current rest confirmation.');
	return locked(`${requestPath(target)}.lock`, async () => {
		if ((await readRequest(target))?.state === 'pending')
			throw new Error('A rest-stop request is already pending.');
		const request: StopRequest = {
			id: randomUUID(),
			actor,
			nonce: process.env.SUMMON_NONCE ?? '',
			confirmation,
			state: 'pending',
			detail: 'Queued for the owning Team Window; not stopped yet.',
		};
		await atomicWrite(requestPath(target), JSON.stringify(request));
		return request;
	});
}

export async function restStopStatus(name: string): Promise<StopRequest | undefined> {
	const actor = await requireRestStopper();
	const request = await readRequest(slugFor(name));
	if (request && actor !== 'operator' && request.actor !== actor)
		throw new Error('This request belongs to another caller.');
	return request;
}

/** Operator-side execution: no peer receives a PID or a general stop capability. */
export async function processRestStops(
	stop: (name: string, confirmation: string) => Promise<void>,
	report: (error: unknown, name: string) => void,
): Promise<void> {
	operatorOnly();
	for (const name of await listAgentSlugs()) {
		try {
			if ((await readRequest(name))?.state !== 'pending') continue;
			await locked(`${requestPath(name)}.lock`, async () => {
				const request = await readRequest(name);
				if (!request || request.state !== 'pending') return;
				try {
					await locked(`${recordPath(request.actor)}.write-lock`, async () => {
						await validateActor(request.actor, request.nonce);
						if (request.actor === name)
							throw new Error('Cannot stop yourself through delegation.');
						await stop(name, request.confirmation);
					});
					request.state = 'done';
					request.detail = 'Stopped after revalidating permission and rest readiness.';
				} catch (error: unknown) {
					request.state = 'failed';
					request.detail = error instanceof Error ? error.message : String(error);
				}
				await atomicWrite(requestPath(name), JSON.stringify(request));
			});
		} catch (error: unknown) {
			report(error, name);
		}
	}
}
