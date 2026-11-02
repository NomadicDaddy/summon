import type { CheckpointPackage, CheckpointState } from './checkpoint-package-model.ts';

import { checkpointText } from './checkpoint-text.ts';
import {
	CATCH_UP_ITEMS,
	CATCH_UP_PAGES,
	CATCH_UP_THRESHOLD,
	checkpointWork,
} from './checkpoint-work.ts';

const JSON_DELIVERY_LIMIT = 28_000;
const TEXT_DELIVERY_LIMIT = 24_000;
const PAYLOAD_LIMIT = 30_000;
/** Above this many pages a returning seat is told about the explicit catch-up preview. */
const DEEP_BACKLOG_PAGES = 3;

/** Whether a page carries catch-up advice: past the hint size, or past the catch-up threshold. */
function wantsCatchUpAdvice(pages: number, items: number): boolean {
	return pages > DEEP_BACKLOG_PAGES || items > CATCH_UP_ITEMS;
}

/**
 * Discoverability only: the page itself creates no plan, moves no cursor and marks nothing read.
 * Past the catch-up threshold the advice says to use catch-up; below it, that a seat may.
 */
function catchUpAdvice(pages: number, items: number): string {
	const size = `This package has ${String(pages)} pages and ${String(items)} items.`;
	const lead =
		pages > CATCH_UP_PAGES || items > CATCH_UP_ITEMS
			? `${size} That is over the catch-up threshold (${CATCH_UP_THRESHOLD}), so use an explicit catch-up instead of reading page by page:`
			: `${size} If most of it is routine history, you may preview an explicit skip instead of reading page by page:`;
	return `${lead} summon --checkpoint catch-up keeps a recent tail and indexes the items addressed to you. List them with summon --checkpoint catch-up list <plan-id>, read each one with the exact read command its entry gives, then apply the plan with summon --checkpoint catch-up apply <plan-id>. Skipped history is recorded as skipped, never as read, handled or approved, and your mail keeps its own state. If catch-up refuses, for example while a Telegram refresh is incomplete, keep its diagnostic, do not retry in a loop or work around it, and continue here: read this page and pass its receipt.`;
}

interface PagePosition {
	id: string;
	phase: 'page' | 'final';
	page: number;
	pages: number;
	items: number;
	forMe: number;
	forMeOnPage: number;
	nextForMePage: number | null;
}

export function checkpointTransport(error?: string) {
	return error
		? {
				telegramRefreshError: error,
				telegramFresh: false,
				transportWarning:
					'Telegram refresh is incomplete. This checkpoint covers local and cached records only; unseen remote updates remain pending. Continue receipts normally; retry Telegram at the next ordinary boundary.',
			}
		: {};
}

function delivery(
	payload: Record<string, unknown>,
	receipt: string,
	position: PagePosition,
	paused: boolean,
	work: boolean,
	error?: string,
	replay?: 'issued' | 'acknowledged',
) {
	return {
		...payload,
		paused,
		receipt,
		changed: position.phase === 'page',
		more: true,
		package: {
			...position,
			manifest: 'summon --checkpoint manifest',
			instruction:
				position.phase === 'page'
					? 'Read this entire page before passing its receipt. Fragments are UTF-8 pieces of the item JSON; continue in order. The manifest is an index, not a substitute for bodies.'
					: 'Every package page has been acknowledged. Pass this final receipt to commit its frozen source cursors. This is read coverage, never approval, handling, or task completion.',
		},
		...(position.phase === 'page' && wantsCatchUpAdvice(position.pages, position.items)
			? { catchUpAdvice: catchUpAdvice(position.pages, position.items) }
			: {}),
		...(work ? { work: checkpointWork() } : {}),
		...checkpointTransport(error),
		...(replay
			? {
					warning:
						replay === 'acknowledged'
							? 'Receipt already acknowledged; read this batch, then pass its returned receipt. Its more describes the original package, not the current backlog; later arrivals are read after acknowledgement.'
							: 'This batch was already issued and is being replayed, not newly read. Read it completely and pass its receipt. Its more describes the original package, not the current backlog; later arrivals are read after acknowledgement.',
				}
			: {}),
	};
}

/** The same complete envelope is used for delivery and prospective page sizing. */
export function checkpointOutput(
	packet: CheckpointPackage,
	state: CheckpointState,
	paused: boolean,
	work: boolean,
	error?: string,
	replay?: 'issued' | 'acknowledged',
) {
	const index = state.current?.page ?? 0;
	const page = packet.pages[index];
	const addressed = packet.items.filter((item) => item.forMe);
	const laterPages = addressed
		.filter((item) => item.lastPage > index)
		.map((item) => Math.max(index + 1, item.firstPage));
	return delivery(
		page?.payload ?? {},
		page?.receipt ?? packet.finalReceipt,
		{
			id: packet.id,
			phase: page ? 'page' : 'final',
			page: page ? index + 1 : packet.pages.length,
			pages: packet.pages.length,
			items: packet.items.length,
			forMe: addressed.length,
			forMeOnPage: page
				? addressed.filter((item) => item.firstPage <= index && item.lastPage >= index)
						.length
				: 0,
			nextForMePage: laterPages.length
				? laterPages.reduce(
						(first, next) => Math.min(first, next),
						Number.POSITIVE_INFINITY,
					) + 1
				: null,
		},
		paused,
		work,
		error,
		replay,
	);
}

/** New pages fit JSON and text including a worst-case live envelope, warnings and newline. */
export function checkpointPageFits(payload: Record<string, unknown>, error?: string): boolean {
	const maximum = Number.MAX_SAFE_INTEGER;
	const uuid = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
	const position: PagePosition = {
		id: uuid,
		phase: 'page',
		page: maximum,
		pages: maximum,
		items: maximum,
		forMe: maximum,
		forMeOnPage: maximum,
		nextForMePage: maximum,
	};
	if (Buffer.byteLength(JSON.stringify(payload)) > PAYLOAD_LIMIT) return false;
	// false is longer than true, and issued is the longer of the two replay warnings.
	const output = delivery(payload, uuid, position, false, true, error, 'issued');
	const json = `${JSON.stringify(output)}\n`;
	const text = `${checkpointText(output, true)}\n`;
	return (
		Buffer.byteLength(json) <= JSON_DELIVERY_LIMIT &&
		json.length <= JSON_DELIVERY_LIMIT &&
		Buffer.byteLength(text) <= TEXT_DELIVERY_LIMIT &&
		text.length <= TEXT_DELIVERY_LIMIT
	);
}
