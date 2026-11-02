import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { requestedKiloVariant } from './kilo-variant.ts';
import { loadAgent, slugFor } from './store.ts';

const execute = promisify(execFile);

type Listing = { variants: string[] } | { skipped: string };

/** `kilo models <provider> --verbose` prints `provider/model` lines, each followed by its JSON. */
export function variantsFromListing(stdout: string, model: string): string[] | undefined {
	const lines = stdout.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === model);
	if (start < 0) return undefined;
	const body: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^[\w.-]+\/\S+$/.test(line.trim())) break;
		body.push(line);
	}
	try {
		const entry = JSON.parse(body.join('\n')) as { variants?: unknown };
		const variants = entry.variants;
		return variants && typeof variants === 'object' ? Object.keys(variants) : [];
	} catch {
		return undefined;
	}
}

async function listing(model: string): Promise<Listing> {
	const provider = model.slice(0, model.indexOf('/'));
	try {
		const { stdout } = await execute('kilo', ['models', provider, '--verbose'], {
			windowsHide: true,
			timeout: 45_000,
			maxBuffer: 16 * 1024 * 1024,
		});
		const variants = variantsFromListing(stdout, model);
		return variants ? { variants } : { skipped: `Kilo did not list ${model}` };
	} catch {
		return { skipped: "Kilo's model list could not be read" };
	}
}

/** Where the model list comes from; tests that save a variant replace it with a fixture. */
export const kiloCatalog = { list: listing };

/** A seat's saved settings, before this edit. */
interface Saved {
	model?: string;
	variant?: string;
}

/**
 * Phillip #20251 A: a variant is checked when it is set or its model changes, never at launch. A
 * model that is listed without the variant is refused; when Kilo can't answer, the setting is kept
 * and the returned note says the check was skipped. `requested` follows applyKiloVariant (absent
 * keeps, '' clears). An edit that leaves model and variant as saved is not checked again.
 */
export async function checkKiloVariant(
	provider: string,
	model: string | undefined,
	requested: string | undefined,
	saved: Saved | undefined,
	usage: string,
	list: (model: string) => Promise<Listing> = (name) => kiloCatalog.list(name),
): Promise<string | undefined> {
	if (!requestedKiloVariant(provider, model, requested)) throw new Error(usage);
	const variant = requested === undefined ? saved?.variant : requested || undefined;
	if (provider !== 'kilo' || !model || !variant) return undefined;
	if (saved?.model === model && saved.variant === variant) return undefined;
	const found = await list(model);
	if ('skipped' in found)
		return `Reasoning variant ${variant} saved without a check: ${found.skipped}.`;
	if (!found.variants.includes(variant))
		throw new Error(
			`${model} does not list the reasoning variant ${variant}; it lists ${found.variants.join(', ') || 'none'}.`,
		);
	return undefined;
}

/** `summon <name> [--model] [--variant]`, printing the note when the check was skipped. */
export async function checkCliKiloVariant(
	record: { provider: string } & Saved,
	model: string | undefined,
	requested: string | undefined,
): Promise<void> {
	const usage = '--variant requires Kilo and a model, and a name like high.';
	const note = await checkKiloVariant(
		record.provider,
		model ?? record.model,
		requested,
		record,
		usage,
	);
	if (note) console.log(note);
}

/**
 * A Team Maintenance save; `existing` is the edited member's name, or null for a new one. A
 * "check skipped" note goes to `report`, which the Team Window shows beside the saved message.
 */
export async function checkFormKiloVariant(
	input: { provider: string; model?: string | undefined; variant?: string | undefined },
	existing: string | null,
	report: (note: string) => void = (note) => console.warn(note),
): Promise<void> {
	const usage = 'A reasoning variant requires Kilo and a model; use a name like high.';
	const saved =
		existing === null ? undefined : await loadAgent(slugFor(existing)).catch(() => undefined);
	const model = input.model || undefined;
	const note = await checkKiloVariant(input.provider, model, input.variant, saved, usage);
	if (note) report(note);
}
