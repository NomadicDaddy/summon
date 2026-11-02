import { join } from 'node:path';
import { z } from 'zod';

import { optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';

// Rest and generated mail read this guard, so it must not depend on their checkpoint schemas.
const schema = z
	.object({
		version: z.literal(1),
		id: z.uuid(),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		phase: z.enum(['applying', 'applied']),
	})
	.strict();
export type SkipProgress = z.infer<typeof schema>;

export function skipProgressPath(name: string): string {
	ownMailbox(name);
	return join(runtimePath(name), 'checkpoint-catch-up.json');
}

export async function skipProgress(name: string) {
	const raw = await optionalText(skipProgressPath(name));
	return raw === undefined ? undefined : schema.parse(JSON.parse(raw) as unknown);
}

export async function catchUpPending(name: string): Promise<boolean> {
	return (await skipProgress(name))?.phase === 'applying';
}

export async function requireSettledCatchUp(name: string): Promise<void> {
	const pending = await skipProgress(name);
	if (pending?.phase === 'applying')
		throw new Error(
			`Catch-up ${pending.id} is incomplete. Resume summon --checkpoint catch-up apply ${pending.id}; no page receipt was acknowledged.`,
		);
}
