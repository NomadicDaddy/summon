import { z } from 'zod';

const variantName = /^[A-Za-z0-9._-]{1,64}$/;
const sessionSchema = z.object({
	id: z.string(),
	model: z.object({ variant: z.string().optional() }).optional(),
});
const modelSchema = z.object({ variants: z.record(z.string(), z.unknown()).optional() });

/**
 * The exact session's own stored reasoning variant, from its owned API response. "default" and
 * anything unreadable count as no choice: sending nothing then leaves Kilo's behaviour unchanged.
 */
export function storedKiloVariant(body: unknown, sessionId: string): string | undefined {
	const session = sessionSchema.safeParse(body);
	if (!session.success || session.data.id !== sessionId) return undefined;
	const variant = session.data.model?.variant;
	return variant && variant !== 'default' && variantName.test(variant) ? variant : undefined;
}

/**
 * A seat's registered default variant: Kilo only, alongside a registered model, and a real choice.
 * "default" is never stored, because it means no setting.
 */
export function validKiloVariant(provider: string, model: unknown, variant: unknown): boolean {
	if (variant === undefined) return true;
	return (
		provider === 'kilo' &&
		typeof model === 'string' &&
		typeof variant === 'string' &&
		variant !== 'default' &&
		variantName.test(variant)
	);
}

/** A requested change is acceptable: absent keeps the setting and '' clears it. */
export function requestedKiloVariant(
	provider: string,
	model: unknown,
	requested: unknown,
): boolean {
	return (
		requested === undefined || requested === '' || validKiloVariant(provider, model, requested)
	);
}

/**
 * Apply a requested change to a record: absent keeps the setting, '' clears it, a name sets it. A
 * kept variant that the record's provider or model no longer allows goes with them.
 */
export function applyKiloVariant(
	record: { provider: string; model?: string; variant?: string },
	requested: string | undefined,
): void {
	if (requested) record.variant = requested;
	else if (requested !== undefined) delete record.variant;
	if (!validKiloVariant(record.provider, record.model, record.variant)) delete record.variant;
}

type CatalogAnswer = { variant: string } | { reason: string; settled: boolean };

/** One /provider read. Unsettled answers (no reply, an error, a catalog still loading) may change. */
async function readCatalog(
	base: string,
	query: string,
	headers: Record<string, string>,
	signal: AbortSignal,
	model: { providerID: string; modelID: string },
	variant: string,
	timeoutMs: number,
): Promise<CatalogAnswer> {
	try {
		const response = await fetch(`${base}/provider${query}`, {
			headers,
			redirect: 'error',
			signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
		});
		if (!response.ok) {
			await response.body?.cancel();
			return { reason: `catalog answered ${response.status}`, settled: false };
		}
		const catalog = (await response.json()) as { all?: unknown };
		const providers = Array.isArray(catalog.all) ? (catalog.all as unknown[]) : [];
		const matches = providers.filter(
			(item): item is { models?: unknown } =>
				typeof item === 'object' &&
				item !== null &&
				(item as { id?: unknown }).id === model.providerID,
		);
		if (matches.length > 1)
			return { reason: `catalog lists provider ${model.providerID} twice`, settled: true };
		const models = matches[0]?.models;
		if (typeof models !== 'object' || models === null || !Object.hasOwn(models, model.modelID))
			return { reason: 'catalog does not list the model yet', settled: false };
		const entry = modelSchema.safeParse((models as Record<string, unknown>)[model.modelID]);
		const variants = entry.success ? entry.data.variants : undefined;
		return variants && Object.hasOwn(variants, variant)
			? { variant }
			: { reason: 'the model does not list it', settled: true };
	} catch {
		signal.throwIfAborted();
		return { reason: 'catalog read failed or timed out', settled: false };
	}
}

/**
 * Kilo can save "default" over a stored variant when a prompt names a model but no variant (unless
 * a matching agent model supplies its own), so the startup turn carries the stored one. It is sent
 * only when the selected model currently lists it. A freshly started Kilo may not answer the
 * catalog yet, so unsettled reads are retried until waitMs; then, or on a settled refusal, none is
 * sent rather than guessed, and the reason is logged so a dropped variant is never silent.
 */
export async function supportedKiloVariant(
	base: string,
	query: string,
	headers: Record<string, string>,
	signal: AbortSignal,
	model: { providerID: string; modelID: string },
	variant: string,
	waitMs = 15_000,
): Promise<string | undefined> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		// Each read gets at most 3 s and never more than the budget left, so the wait holds.
		const timeoutMs = Math.max(1, Math.min(3000, deadline - Date.now()));
		const answer = await readCatalog(base, query, headers, signal, model, variant, timeoutMs);
		if ('variant' in answer) return answer.variant;
		if (answer.settled || Date.now() + 500 > deadline) {
			console.error(`Kilo reasoning variant ${variant} not sent: ${answer.reason}.`);
			return undefined;
		}
		await Bun.sleep(500);
		signal.throwIfAborted();
	}
}
