import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

import { readActivity } from './agent-activity.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';

const nonceSchema = z
	.string()
	.regex(/^[a-z0-9-]+$/i)
	.nullable();
const failureSchema = z
	.object({
		id: z.uuid(),
		owner: z.string(),
		observedNonce: nonceSchema,
		failedAt: z.iso.datetime(),
		recoveredAt: z.iso.datetime().optional(),
		recoveredByNonce: nonceSchema.optional(),
	})
	.strict();
const indexSchema = z.object({ id: z.uuid() }).strict();
const indexPath = (name: string) => join(runtimePath(name), 'response-watchdog-errors.json');
const episodePath = (name: string, id: string) =>
	join(runtimePath(name), 'response-watchdog-errors', `${z.uuid().parse(id)}.json`);

/** Separate storage is intentional: the previous release never opens these diagnostics. */
export async function responseFailure(name: string) {
	ownMailbox(name);
	const raw = await optionalText(indexPath(name));
	if (raw === undefined) return null;
	try {
		if (Buffer.byteLength(raw) > 1024) throw new Error('Oversized index');
		const { id } = indexSchema.parse(JSON.parse(raw) as unknown);
		const body = (await optionalText(episodePath(name, id))) ?? '';
		if (Buffer.byteLength(body) > 4096) throw new Error('Oversized episode');
		const value = failureSchema.parse(JSON.parse(body) as unknown);
		if (value.id !== id || value.owner !== name) throw new Error('Identity mismatch');
		return value;
	} catch {
		throw new Error(
			'Response watchdog diagnostic unavailable; retained files were not changed.',
		);
	}
}

async function observedNonce(name: string) {
	const activity = await readActivity(name).catch(() => undefined);
	return activity && /^[a-z0-9-]+$/i.test(activity.nonce) ? activity.nonce : null;
}

/** No raw error content, provider-write classification, or retry authority is stored here. */
export async function retainResponseFailure(name: string): Promise<boolean> {
	ownMailbox(name);
	return locked(`${indexPath(name)}.lock`, async () => {
		const previous = await responseFailure(name);
		const nonce = await observedNonce(name);
		if (previous && !previous.recoveredAt && previous.observedNonce === nonce) return false;
		const value = failureSchema.parse({
			id: randomUUID(),
			owner: name,
			observedNonce: nonce,
			failedAt: new Date().toISOString(),
		});
		await atomicWrite(episodePath(name, value.id), JSON.stringify(value));
		await atomicWrite(indexPath(name), JSON.stringify({ id: value.id }));
		return true;
	});
}

/** Only a successful watchdog evaluation recovers the current diagnostic episode. */
export async function recoverResponseFailure(name: string): Promise<void> {
	ownMailbox(name);
	await locked(`${indexPath(name)}.lock`, async () => {
		const previous = await responseFailure(name);
		if (!previous || previous.recoveredAt) return;
		await atomicWrite(
			episodePath(name, previous.id),
			JSON.stringify({
				...previous,
				recoveredAt: new Date().toISOString(),
				recoveredByNonce: await observedNonce(name),
			}),
		);
	});
}

export async function responseFailureView(name: string, nonce: string) {
	try {
		const failure = await responseFailure(name);
		return {
			responseWatchdogFailure: failure,
			...(failure &&
			!failure.recoveredAt &&
			(failure.observedNonce === nonce || failure.observedNonce === null)
				? {
						responseWatchdogError:
							'Delivery response observation unavailable; inspect retained diagnostic.',
					}
				: {}),
		};
	} catch {
		return {
			responseWatchdogFailure: null,
			responseWatchdogError:
				'Delivery response diagnostic unavailable; retained files could not be read.',
		};
	}
}
