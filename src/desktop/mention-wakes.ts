import { join } from 'node:path';

import { atomicWrite, locked, optionalText } from '../mail-files.ts';
import { runtimePath } from '../mail-session.ts';

export interface PendingMentionWake {
	through: number;
	notifiedNonce?: string;
	notify?: boolean;
}

const pathFor = (name: string): string => join(runtimePath(name), 'mention-wake.json');

function parse(text: string | undefined): PendingMentionWake | undefined {
	if (text === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error('Invalid pending mention wake.');
	}
	if (!value || typeof value !== 'object') throw new Error('Invalid pending mention wake.');
	const record = value as Record<string, unknown>;
	if (
		!Number.isSafeInteger(record.through) ||
		Number(record.through) < 0 ||
		(record.notifiedNonce !== undefined &&
			(typeof record.notifiedNonce !== 'string' ||
				!/^[a-z0-9-]+$/i.test(record.notifiedNonce))) ||
		(record.notify !== undefined && typeof record.notify !== 'boolean') ||
		Object.keys(record).some((key) => !['through', 'notifiedNonce', 'notify'].includes(key))
	)
		throw new Error('Invalid pending mention wake.');
	return {
		through: Number(record.through),
		...(record.notify === false ? { notify: false } : {}),
		...(typeof record.notifiedNonce === 'string'
			? { notifiedNonce: record.notifiedNonce }
			: {}),
	};
}

export async function readPendingMentionWake(
	name: string,
): Promise<PendingMentionWake | undefined> {
	return parse(await optionalText(pathFor(name)));
}

export async function queueMentionWake(
	name: string,
	through: number,
	notify = true,
): Promise<void> {
	if (!Number.isSafeInteger(through) || through < 1)
		throw new Error('Invalid pending mention cursor.');
	const path = pathFor(name);
	await locked(`${path}.lock`, async () => {
		const previous = parse(await optionalText(path));
		if (previous && previous.through >= through && (previous.notify !== false || !notify))
			return;
		const deliver =
			notify ||
			(previous &&
				previous.through > 0 &&
				previous.notify !== false &&
				!previous.notifiedNonce);
		await atomicWrite(
			path,
			JSON.stringify({
				through: Math.max(through, previous?.through ?? 0),
				...(!deliver ? { notify: false } : {}),
			}),
		);
	});
}

export async function clearMentionWake(name: string, through: number): Promise<void> {
	const path = pathFor(name);
	await locked(`${path}.lock`, async () => {
		const current = parse(await optionalText(path));
		if (current && current.through <= through)
			await atomicWrite(path, JSON.stringify({ through: 0 }));
	});
}
