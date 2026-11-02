import type { MailHeader, ReceivedMail } from './mail-read.ts';

import { missing } from './mail-files.ts';
import { messageId } from './mail-identity.ts';
import { header, receiveMail } from './mail-read.ts';

/** Every kind Summon writes into received mail; a header without one reads as a request. */
export const mailKinds = [
	'request',
	'reply',
	'confirmation',
	'receipt',
	'rest-ready',
	'notice',
] as const;
export type MailKind = (typeof mailKinds)[number];

export interface ReceiveFilter {
	kind?: MailKind;
	since?: string;
}

export interface ReceiveRequest {
	cursor?: string;
	pending: boolean;
	filter: ReceiveFilter;
}

export type FilteredMail = ReceivedMail & { filter?: ReceiveFilter };

const usage =
	'Usage: summon --mail receive [cursor] [--pending] [--kind <kind>] [--since <message-id>]';

function isKind(value: string): value is MailKind {
	return (mailKinds as readonly string[]).includes(value);
}

export function parseReceiveArgs(args: string[]): ReceiveRequest {
	const request: ReceiveRequest = { pending: false, filter: {} };
	const flags = new Set<string>();
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? '';
		if (arg.startsWith('--')) {
			if (flags.has(arg)) throw new Error(usage);
			flags.add(arg);
		}
		if (arg === '--pending') request.pending = true;
		else if (arg === '--kind' || arg === '--since') {
			index += 1;
			const value = args[index];
			if (!value || value.startsWith('--')) throw new Error(usage);
			if (arg === '--since') request.filter.since = messageId(value);
			else if (isKind(value)) request.filter.kind = value;
			else throw new Error(`Unknown mail kind; use one of ${mailKinds.join(', ')}.`);
		} else if (arg.startsWith('--') || request.cursor !== undefined) throw new Error(usage);
		else request.cursor = arg;
	}
	return request;
}

/** The since anchor is a message this name received: current inbox first, then own archive. */
async function sinceAnchor(name: string, id: string): Promise<MailHeader> {
	for (const archive of [false, true]) {
		try {
			return await header(name, id, archive);
		} catch (error: unknown) {
			if (!missing(error)) throw error;
		}
	}
	throw new Error(
		'The --since message is not in your own inbox or archive; name a message you received.',
	);
}

function scope({ kind, since }: ReceiveFilter): string {
	const terms = [kind && `kind ${kind}`, since && `sent after ${since}`].filter(Boolean);
	return `Filtered view (${terms.join(', ')}): only matching messages are listed, and only their complete bodies are marked read. Omitted messages keep their read and pending state, so this is not complete unread, pending or checkpoint coverage; any counts describe the whole unfiltered view. Continue with the same filters and the next cursor.`;
}

export async function receiveFiltered(
	name: string,
	request: ReceiveRequest,
): Promise<FilteredMail> {
	const { kind, since } = request.filter;
	const view = request.pending ? 'pending' : 'unread';
	if (kind === undefined && since === undefined)
		return receiveMail(name, request.cursor, true, view);
	const after = since === undefined ? undefined : await sinceAnchor(name, since);
	const result = await receiveMail(
		name,
		request.cursor,
		true,
		view,
		(mail) =>
			(kind === undefined || mail.kind === kind) &&
			(after === undefined ||
				(mail.sent.localeCompare(after.sent) || mail.id.localeCompare(after.id)) > 0),
	);
	return {
		...result,
		filter: request.filter,
		instruction: `${scope(request.filter)} ${result.instruction}`,
	};
}
