import type { Provider } from './store.ts';

export interface ModelInfo {
	provider: Provider;
	sessionId: string;
	model: string;
	reasoning?: string;
	/**
	 * The model's context capacity in tokens (Phillip #7387, Yes #7388): what the window can
	 * hold, never how full it is. Absent when the provider records nothing reliable; it is
	 * never derived from the model name.
	 */
	contextWindow?: number;
	observedAt: string;
}

export function metadataText(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value.length || value.length > 200) return undefined;
	for (const char of value) {
		if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) return undefined;
	}
	return value;
}

export function validModelInfo(value: unknown): value is ModelInfo {
	if (!value || typeof value !== 'object') return false;
	const info = value as Record<string, unknown>;
	return (
		['codex', 'claude', 'grok', 'kilo'].includes(String(info.provider)) &&
		!!metadataText(info.sessionId) &&
		!!metadataText(info.model) &&
		(info.reasoning === undefined || !!metadataText(info.reasoning)) &&
		(info.contextWindow === undefined ||
			(Number.isSafeInteger(info.contextWindow) && Number(info.contextWindow) > 0)) &&
		typeof info.observedAt === 'string' &&
		Number.isFinite(Date.parse(info.observedAt))
	);
}
