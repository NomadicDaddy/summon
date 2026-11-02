import { randomUUID } from 'node:crypto';

import type { LocalEvent } from './local-room.ts';
import type { Hold } from './mail-attention.ts';
import type { MailHeader } from './mail-read.ts';
import type { TelegramConfig } from './telegram-api.ts';
import type { RoomEvent } from './telegram-room.ts';

import { checkpointMirrors } from './checkpoint-mirrors.ts';
import { checkpointPageFits } from './checkpoint-output.ts';
import {
	checkpointHash,
	type CheckpointPackage,
	type PackageItem,
	type PackagePage,
} from './checkpoint-package-model.ts';
import { boundedBytes } from './mail-read.ts';

type RoomValue = LocalEvent & {
	imagePath?: string;
	ownBodyOmitted?: true;
	digest?: { kind: 'excerpt'; originalCharacters: number; readOriginal: string };
};
interface InputBase {
	id: string;
	forMe: boolean;
	presentation: PackageItem['presentation'];
}
export type CheckpointInput = InputBase &
	(
		| { source: 'room'; value: RoomValue }
		| { source: 'telegram'; value: RoomEvent }
		| { source: 'mail'; value: { header: MailHeader; text: string } }
		| { source: 'hold'; value: Hold }
		| { source: 'mail-error'; value: { id: string; error: string } }
	);
interface Part {
	input: CheckpointInput;
	item: number;
	text?: string;
	offset: number;
	end: number;
	size: number;
}
export interface PageContext {
	roomThrough: number;
	telegramThrough: number;
	startedAt: string | null;
	paused: boolean;
	sources: CheckpointPackage['sources'];
	config?: TelegramConfig;
	telegramRefreshError?: string;
}
const WHOLE_ITEM_BYTES = 24_000;
const FRAGMENT_BYTES = 12_000;
type PagePurpose = 'checkpoint' | 'current-requests';

function pageFits(parts: Part[], context: PageContext, purpose: PagePurpose): boolean {
	const value = payload(parts, context);
	return purpose === 'current-requests'
		? Buffer.byteLength(JSON.stringify(value)) <= 30_000
		: checkpointPageFits(value, context.telegramRefreshError);
}

function partsFor(
	input: CheckpointInput,
	item: number,
	context: PageContext,
	purpose: PagePurpose,
): Part[] {
	const bytes = Buffer.from(JSON.stringify(input.value));
	const whole = { input, item, offset: 0, end: bytes.length, size: bytes.length };
	const focused = purpose === 'current-requests';
	if (bytes.length <= WHOLE_ITEM_BYTES && (focused || pageFits([whole], context, purpose)))
		return [whole];
	const parts: Part[] = [];
	for (let offset = 0; offset < bytes.length;) {
		let limit = FRAGMENT_BYTES;
		for (;;) {
			const chunk = boundedBytes(bytes.subarray(offset), limit);
			const part = {
				input,
				item,
				text: chunk.text,
				offset,
				end: offset + chunk.count,
				size: bytes.length,
			};
			if (chunk.count && (focused || pageFits([part], context, purpose))) {
				parts.push(part);
				offset = part.end;
				break;
			}
			if (limit <= 4)
				throw new Error(
					'Checkpoint fragment exceeds its delivery bound. Nothing was acknowledged.',
				);
			limit = Math.max(4, Math.floor(limit / 2));
		}
	}
	return parts;
}

/** Render exactly one prospective page; no read markers or source cursors are changed. */
function payload(parts: Part[], context: PageContext): Record<string, unknown> {
	const room: RoomValue[] = [];
	const telegram: RoomEvent[] = [];
	const messages: (
		| { header: MailHeader; text: string }
		| { header: MailHeader; oversized: true; fragmented: true }
	)[] = [];
	const errors: { id: string; error: string }[] = [];
	const holds: (Hold | { id: string; oversized: true; fragmented: true })[] = [];
	const fragments: Record<string, unknown>[] = [];
	let roomThrough = context.roomThrough;
	let telegramThrough = context.telegramThrough;
	for (const part of parts) {
		const input = part.input;
		if (part.text !== undefined) {
			fragments.push({
				source: input.source,
				id: input.id,
				item: part.item,
				encoding: 'json',
				text: part.text,
				offset: part.offset,
				end: part.end,
				size: part.size,
			});
			if (part.offset === 0 && input.source === 'mail')
				messages.push({ header: input.value.header, oversized: true, fragmented: true });
			if (part.offset === 0 && input.source === 'hold')
				holds.push({ id: input.value.id, oversized: true, fragmented: true });
		} else {
			if (input.source === 'room') room.push(input.value);
			else if (input.source === 'telegram') telegram.push(input.value);
			else if (input.source === 'mail') messages.push(input.value);
			else if (input.source === 'hold') holds.push(input.value);
			else errors.push(input.value);
		}
		if (part.end === part.size) {
			if (input.source === 'room') roomThrough = input.value.id;
			if (input.source === 'telegram') telegramThrough = input.value.sequence;
		}
	}
	const roomPage = {
		catchUp:
			'Older routine peer posts may be excerpts, not complete summaries. Read originals when needed. Receipt acknowledges this delivered digest only; it is not approval or task completion.',
		lastTeamWindowStartedAt: context.startedAt,
		paused: context.paused,
		events: room,
		nextCursor: roomThrough,
		more: roomThrough < context.sources.room.through,
	};
	const telegramPage = {
		paused: context.paused,
		events: telegram,
		nextCursor: telegramThrough,
		more: telegramThrough < (context.sources.telegram?.through ?? telegramThrough),
	};
	// v1 readers permit payload extensions, but reject new package-envelope fields.
	// Include the warning while measuring prospective pages, before hashing/publication.
	const result: Record<string, unknown> = context.telegramRefreshError
		? { telegramRefreshError: context.telegramRefreshError }
		: {};
	if (room.length) result.room = roomPage;
	if (telegram.length)
		result.telegram = context.config
			? checkpointMirrors(roomPage, telegramPage, context.config)
			: telegramPage;
	if (messages.length || errors.length) result.mail = { messages, errors };
	if (holds.length) result.holds = holds;
	if (fragments.length) result.fragments = fragments;
	return result;
}

export function checkpointPages(
	inputs: CheckpointInput[],
	initial: PageContext,
	purpose: PagePurpose = 'checkpoint',
): {
	items: PackageItem[];
	pages: PackagePage[];
} {
	const items: PackageItem[] = inputs.map((input) => ({
		source: input.source,
		id: input.id,
		sha256: checkpointHash(input.value),
		bytes: Buffer.byteLength(JSON.stringify(input.value)),
		forMe: input.forMe,
		presentation: input.presentation,
		firstPage: 0,
		lastPage: 0,
		parts: 0,
	}));
	const pages: PackagePage[] = [];
	const context = { ...initial };
	let pending: Part[] = [];
	const flush = (): void => {
		if (!pending.length) return;
		const pageIndex = pages.length;
		const rendered = payload(pending, context);
		const completeMail: MailHeader[] = [];
		for (const part of pending) {
			const item = items[part.item];
			if (!item) throw new Error('Missing checkpoint manifest item.');
			if (item.parts === 0) item.firstPage = pageIndex;
			item.lastPage = pageIndex;
			item.parts += 1;
			if (part.end === part.size) {
				if (part.input.source === 'mail') completeMail.push(part.input.value.header);
				if (part.input.source === 'room') context.roomThrough = part.input.value.id;
				if (part.input.source === 'telegram')
					context.telegramThrough = part.input.value.sequence;
			}
		}
		pages.push({ receipt: randomUUID(), payload: rendered, completeMail });
		pending = [];
	};
	for (const [item, input] of inputs.entries()) {
		for (const part of partsFor(input, item, context, purpose)) {
			const candidate = [...pending, part];
			if (
				pending.length &&
				((purpose === 'current-requests' && pending.length >= 20) ||
					!pageFits(candidate, context, purpose))
			)
				flush();
			if (!pageFits([part], context, purpose))
				throw new Error(
					'Checkpoint fragment exceeds its page bound. Nothing was acknowledged.',
				);
			pending.push(part);
		}
	}
	flush();
	return { items, pages };
}
