import type { ModelInfo } from '../model-info.ts';

/**
 * A context capacity in human units. Decimal is the default (200000 reads 200K); binary only
 * when it gives a whole number and decimal does not (262144 reads 256K, 1048576 reads 1M); a
 * value whole in neither keeps one decimal (1500000 reads 1.5M). This is a display convention
 * for a recorded token count, not a verified reproduction of any provider's own UI, which is
 * why every surface prints the exact tokens beside it (Morgan 0f5a1a5c).
 */
export function contextWindowText(tokens: number): string {
	const scaled = (unit: number): [number, string] => {
		const mega = unit * unit;
		return tokens >= mega ? [tokens / mega, 'M'] : [tokens / unit, 'K'];
	};
	const decimal = scaled(1000);
	const binary = scaled(1024);
	const [value, suffix] =
		Number.isInteger(decimal[0]) || !Number.isInteger(binary[0]) ? decimal : binary;
	const text = Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
	return `${text}${suffix}`;
}

/** The capacity with its exact token count, so 1M cannot conceal 1000000 against 1048576. */
export function contextCapacityText(tokens?: number): string {
	return tokens === undefined
		? 'capacity not recorded'
		: `${contextWindowText(tokens)} (${tokens} tokens)`;
}

/**
 * The three recorded settings every teammate surface shows: model, reasoning and context
 * capacity (Phillip #7402, Steward 9429c9b6). Capacity is what the window can hold, never how
 * full it is. One place decides the wording for a value nobody has recorded, so the surfaces
 * cannot drift into saying different things about the same absence. Present values carry no
 * label; a missing one names its field, so a row of absences still says which is which
 * (Morticia #8029, Phillip #8054).
 */
export function recordedSettings(info?: ModelInfo): {
	model: string;
	reasoning: string;
	capacity: string;
} {
	return {
		model: info?.model ?? 'model not recorded',
		reasoning: info
			? (info.reasoning ?? 'reasoning not exposed by provider')
			: 'reasoning not recorded',
		capacity: contextCapacityText(info?.contextWindow),
	};
}
