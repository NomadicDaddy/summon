import { z } from 'zod';

const position = z.number().int().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z
	.object({
		version: z.literal(1),
		owner: z.string(),
		root: hash,
		capturedAt: z.iso.datetime(),
		roomFrom: position,
		roomThrough: position,
		telegram: z.object({ from: position, through: position, key: hash }).strict().optional(),
		page: position,
		hash,
	})
	.strict();
export type CurrentRequestCursor = z.infer<typeof schema>;
export type CurrentRequestBoundary = Omit<CurrentRequestCursor, 'page' | 'hash'>;

export function encodeCurrentRequestCursor(value: CurrentRequestCursor): string {
	return Buffer.from(JSON.stringify(schema.parse(value))).toString('base64url');
}

export function decodeCurrentRequestCursor(value: string): CurrentRequestCursor {
	try {
		if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
		return schema.parse(
			JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown,
		);
	} catch {
		throw new Error('Invalid current-request cursor. Start summon --current-requests again.');
	}
}
