import { createHash } from 'node:crypto';
import { z } from 'zod';

const pinsSchema = z
	.object({
		version: z.literal(1),
		owner: z.string(),
		sources: z
			.array(
				z
					.object({
						id: z.string().min(1).max(200),
						sha256: z.string().regex(/^[a-f0-9]{64}$/i),
						complete: z.boolean(),
						citations: z.array(z.string().min(1).max(256)).max(10000),
					})
					.strict(),
			)
			.max(100),
	})
	.strict();

/** Conservative token extraction also recognizes abbreviated IDs touching prose labels. */
function retentionTokens(text: string): string[] {
	if (text.length > 256) throw new Error('A pin citation must fit in 256 characters.');
	const tokens = new Set<string>();
	for (const raw of text.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-f0-9]{8,}/gi) ??
		[]) {
		const token = raw.toLowerCase();
		tokens.add(token);
		// Labels may end in hex characters: preserve every possible attached prefix.
		if (!token.includes('-'))
			for (let offset = 1; offset <= token.length - 8; offset += 1)
				tokens.add(token.slice(offset));
	}
	return [...tokens];
}

export function retentionPins(owner: string, encoded: string | null) {
	if (encoded === null) return { sha256: null, tokens: [] as string[], sourceCount: 0 };
	const body = Buffer.from(encoded, 'base64');
	if (body.length > 1_000_000) throw new Error('Pins input exceeds 1000000 bytes.');
	const value = pinsSchema.parse(
		JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown,
	);
	if (value.owner !== owner) throw new Error('Pins belong to another mailbox owner.');
	const tokens = new Set<string>();
	for (const source of value.sources)
		for (const citation of source.citations)
			for (const token of retentionTokens(citation)) {
				tokens.add(token);
				if (tokens.size > 20000)
					throw new Error('Too many distinct pin tokens; nothing was planned.');
			}
	return {
		sha256: createHash('sha256').update(body).digest('hex'),
		tokens: [...tokens],
		sourceCount: value.sources.length,
	};
}

export function retentionPinned(id: string | null, tokens: string[]): boolean {
	return id !== null && tokens.some((token) => id.toLowerCase().startsWith(token));
}
