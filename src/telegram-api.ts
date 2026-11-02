import { join } from 'node:path';

import { storageRoot } from './store.ts';
import { readTelegramConfig } from './telegram-config-file.ts';

export interface TelegramConfig {
	botToken: string;
	chatId: string;
	allowedUserIds: string[];
}

/** Public diagnostics never retain fetch errors, which may contain the credential-bearing URL. */
export class TelegramRequestError extends Error {
	readonly reason: string;
	/** A blip that usually clears on the next refresh: a timeout, a dropped connection, HTTP 429 or 5xx. */
	readonly transient: boolean;

	constructor(reason: string, transient = false) {
		super(
			`Telegram request could not be confirmed. ${reason} Check the chat before retrying a send.`,
		);
		this.name = 'TelegramRequestError';
		this.reason = reason;
		this.transient = transient;
	}
}

/** Certificate verification failures as Bun and Node report them: untrusted, expired, or the wrong name. */
const CERTIFICATE_FAILURES = new Set([
	'CERT_HAS_EXPIRED',
	'CERT_NOT_YET_VALID',
	'CERT_UNTRUSTED',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'ERR_TLS_CERT_ALTNAME_INVALID',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_GET_ISSUER_CERT',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function requestFailure(error: unknown): TelegramRequestError {
	const details = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
	if (details.name === 'TimeoutError' || details.name === 'AbortError')
		return new TelegramRequestError('The Telegram request timed out.', true);
	// A certificate failure will not clear by itself, so it is the one connection failure reported at once.
	if (typeof details.code === 'string' && CERTIFICATE_FAILURES.has(details.code))
		return new TelegramRequestError('Telegram TLS certificate verification failed.');
	const codes: Record<string, string> = {
		EAI_AGAIN: 'Telegram DNS lookup temporarily failed.',
		ECONNREFUSED: 'The connection to Telegram was refused.',
		ECONNRESET: 'The connection to Telegram was reset.',
		ENOTFOUND: 'Telegram DNS lookup failed.',
		ETIMEDOUT: 'The connection to Telegram timed out.',
	};
	return new TelegramRequestError(
		typeof details.code === 'string' && Object.hasOwn(codes, details.code)
			? (codes[details.code] ?? 'The Telegram network request failed.')
			: 'The Telegram network request failed.',
		true,
	);
}

async function readBounded(response: Response): Promise<string> {
	const limit = 4 * 1024 * 1024;
	if (Number(response.headers.get('content-length')) > limit) {
		await response.body?.cancel();
		throw new TelegramRequestError('The Telegram response exceeded the 4 MiB safety limit.');
	}
	if (!response.body)
		throw new TelegramRequestError('Telegram returned an empty response.', true);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return text + decoder.decode();
			bytes += value.byteLength;
			if (bytes > limit) {
				await reader.cancel();
				throw new TelegramRequestError(
					'The Telegram response exceeded the 4 MiB safety limit.',
				);
			}
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

export async function telegramConfig(readOnly = false): Promise<TelegramConfig> {
	const path = join(storageRoot(), 'integrations', 'telegram.json');
	const raw = await readTelegramConfig(path, readOnly);
	if (!raw) throw new Error(`Telegram is not configured. Configure ${path}.`);
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		throw new Error('Invalid Telegram configuration JSON.');
	}
	if (!value || typeof value !== 'object') throw new Error('Invalid Telegram configuration.');
	const config = value as Record<string, unknown>;
	if (
		typeof config.botToken !== 'string' ||
		!/^\d+:[A-Za-z0-9_-]+$/.test(config.botToken) ||
		typeof config.chatId !== 'string' ||
		!/^-?\d+$/.test(config.chatId)
	)
		throw new Error('Telegram configuration requires botToken and numeric chatId strings.');
	// A private chat's positive ID identifies its sole human participant. Groups require an allowlist.
	const ids = config.allowedUserIds ?? (Number(config.chatId) > 0 ? [config.chatId] : []);
	if (
		!Array.isArray(ids) ||
		!ids.every((id: unknown) => typeof id === 'string' && /^\d+$/.test(id))
	)
		throw new Error('Telegram allowedUserIds must be an array of numeric user ID strings.');
	if (Number(config.chatId) < 0 && ids.length === 0)
		throw new Error('Group chats require allowedUserIds in telegram.json.');
	return { botToken: config.botToken, chatId: config.chatId, allowedUserIds: ids as string[] };
}

export async function telegramRequest(
	config: TelegramConfig,
	method: 'sendMessage' | 'getUpdates',
	body: Record<string, unknown>,
): Promise<unknown> {
	let response: Response;
	let value: unknown;
	let parsing = false;
	try {
		response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: 'POST',
			redirect: 'error',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15_000),
		});
		const text = await readBounded(response);
		parsing = true;
		value = JSON.parse(text) as unknown;
	} catch (error: unknown) {
		if (error instanceof TelegramRequestError) throw error;
		throw parsing
			? new TelegramRequestError('Telegram returned invalid JSON.', true)
			: requestFailure(error);
	}
	if (
		!response.ok ||
		!value ||
		typeof value !== 'object' ||
		!('ok' in value) ||
		value.ok !== true ||
		!('result' in value)
	)
		throw new TelegramRequestError(
			`Telegram rejected the request (HTTP ${response.status}). Check bot access and configuration.`,
			response.status === 429 || response.status >= 500,
		);
	return value.result;
}
