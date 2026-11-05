import { atomicWrite, optionalText } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import { processAlive } from './process-owner.ts';
import { teamWindowRuntime } from './team-startup.ts';

const path = (): string => teamWindowRuntime('operator-view.json');

/** A short lease prevents a crashed window from silencing a session indefinitely. */
export async function saveOperatorView(
	name: string,
	now = Date.now(),
	until = now + 6000,
): Promise<void> {
	operatorOnly();
	await atomicWrite(
		path(),
		JSON.stringify({ name, pid: process.pid, expires: Math.min(now + 6000, until) }),
	);
}

export async function operatorViewExpiry(
	name: string,
	now = Date.now(),
): Promise<number | undefined> {
	const text = await optionalText(path());
	if (!text) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object') return undefined;
	const entry = value as Record<string, unknown>;
	if (
		entry.name === name &&
		typeof entry.expires === 'number' &&
		entry.expires > now &&
		entry.expires <= now + 6000 &&
		typeof entry.pid === 'number' &&
		processAlive(entry.pid)
	)
		return entry.expires;
	return undefined;
}

export async function operatorViewing(name: string, now = Date.now()): Promise<boolean> {
	return (await operatorViewExpiry(name, now)) !== undefined;
}
