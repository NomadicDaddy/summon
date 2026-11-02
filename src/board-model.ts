import { z } from 'zod';

import { boardStates } from './board-states.ts';
/**
 * Reject the C0 control characters that would corrupt a stored card, keeping the three that are
 * ordinary text: tab, newline and carriage return.
 *
 * Checked by character code rather than by a regular expression holding literal control characters,
 * which is unreadable in source and cannot be reviewed for the range it actually covers.
 * @param value The text to check.
 * @returns True when the text carries no forbidden control character.
 */
const printable = (value: string): boolean => {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
	}
	return true;
};
const text = (max: number) => z.string().max(max).refine(printable);
const name = z
	.string()
	.max(64)
	.regex(/^(?:[a-z0-9][a-z0-9._-]*)?$/);
export const boardFields = z
	.object({
		title: text(200).refine((value) => value.trim().length > 0),
		project: text(200),
		owner: name,
		partner: name,
		description: text(8000),
		state: z.enum(boardStates),
		blockedOn: z
			.object({
				kind: z.enum(['human', 'agent', 'task', 'external']),
				target: text(200).refine((value) => value.trim().length > 0),
				reason: text(2000).refine((value) => value.trim().length > 0),
			})
			.strict()
			.nullable(),
		evidence: z.array(text(1000).refine((value) => value.trim().length > 0)).max(20),
		/**
		 * Kept off every lane rather than forming one of its own.
		 *
		 * Orthogonal to state, so an archived card keeps the state it finished in and its history
		 * stays readable. Archiving does not free a slot against the item cap — see `boardDocument`.
		 */
		archived: z.boolean(),
	})
	.strict();
const actorSchema = z
	.object({ kind: z.enum(['operator', 'agent']), id: z.string().min(1).max(64) })
	.strict();
/**
 * One remark against a card, attributed and never edited.
 *
 * `revision` is the card's revision at the moment the remark landed, set by the server rather than
 * supplied. A comment is about what the card said when it was written, and the card keeps changing;
 * pairing the remark with a revision keeps that recoverable from history instead of guessable.
 */
export const boardCommentSchema = z
	.object({
		at: z.iso.datetime(),
		actor: actorSchema,
		revision: z.number().int().positive(),
		body: text(4000).refine((value) => value.trim().length > 0),
	})
	.strict();
export const boardItemSchema = boardFields
	.extend({
		id: z.uuid(),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso.datetime(),
		revision: z.number().int().positive(),
		/**
		 * Append-only, and deliberately outside `boardFields` so no patch can rewrite or drop it.
		 * Comments arrive through their own call; a field patch carries them forward untouched.
		 */
		comments: z.array(boardCommentSchema).max(200),
	})
	.strict();
export type BoardItem = z.infer<typeof boardItemSchema>;
export type BoardFields = z.infer<typeof boardFields>;
/**
 * A card as history records it: every field, without the comments.
 *
 * History exists to say what the fields were when somebody acted, and `before`/`after` are full
 * snapshots rather than diffs so that scope stays recoverable. Comments carry their own timestamp,
 * actor and revision, so copying them into both halves of every change would add bytes and no
 * information — and history is append-only, so that weight could never be reclaimed.
 */
export const boardSnapshotSchema = boardItemSchema.omit({ comments: true });
export const boardChangeSchema = z
	.object({
		at: z.iso.datetime(),
		actor: actorSchema,
		itemId: z.uuid(),
		before: boardSnapshotSchema.nullable(),
		after: boardSnapshotSchema,
	})
	.strict();
export type BoardChange = z.infer<typeof boardChangeSchema>;
export const boardDocumentSchema = z
	.object({
		version: z.literal(1),
		revision: z.number().int().nonnegative(),
		items: z.array(boardItemSchema).max(1000),
		history: z.array(boardChangeSchema),
	})
	.strict();
export type BoardDocument = z.infer<typeof boardDocumentSchema>;
export interface BoardSnapshot {
	revision: number;
	items: BoardItem[];
}
/**
 * One teammate's startable work, deliberately without descriptions or evidence: enough to choose a
 * card, not enough to understand it. See `boardWork` for why the distinction is the whole point.
 */
export interface BoardWork {
	owner: string;
	items: {
		id: string;
		project: string;
		state: BoardItem['state'];
		title: string;
		partner?: string;
	}[];
}
