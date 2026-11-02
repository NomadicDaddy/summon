/** Presentation and Diary addressing only; never a permission, role or wake grant. */
export interface OperatorIdentity {
	display: string;
	/** Personal names accepted in Room prose and Diary recipients. */
	aliases: string[];
	/** Role names highlighted in Room only with @, also accepted by the Diary. */
	mentionOnly: string[];
	/** Diary recipient shorthand that must not highlight ordinary Room prose. */
	recipientAliases: string[];
}

export const DEFAULT_OPERATOR_IDENTITY: OperatorIdentity = {
	display: 'Operator',
	aliases: [],
	mentionOnly: ['operator'],
	recipientAliases: ['op', 'me'],
};

const namePattern = /^[\p{L}\p{N}][\p{L}\p{N} _.'’-]{0,63}$/u;
function name(value: unknown): string {
	if (
		typeof value !== 'string' ||
		value !== value.trim() ||
		!namePattern.test(value) ||
		value.toLowerCase() === 'all'
	)
		throw new Error(
			'Operator identity names must be 1–64 plain characters, without @ or broadcast names.',
		);
	return value;
}
function names(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 16)
		throw new Error('Operator alias lists require at most 16 names.');
	const result = value.map((item: unknown) => name(item));
	if (new Set(result.map((item) => item.toLowerCase())).size !== result.length)
		throw new Error('Duplicate operator identity alias.');
	return result;
}

export function parseOperatorIdentity(value: unknown): OperatorIdentity {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid operator identity.');
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		Object.keys(record).some(
			(key) =>
				!['version', 'display', 'aliases', 'mentionOnly', 'recipientAliases'].includes(key),
		)
	)
		throw new Error('Invalid operator identity version or fields.');
	const identity = {
		display: name(record.display),
		aliases: names(record.aliases),
		mentionOnly: names(record.mentionOnly),
		recipientAliases: names(record.recipientAliases),
	};
	const prose = new Set(identity.aliases.map((item) => item.toLowerCase()));
	if (!identity.mentionOnly.some((item) => item.toLowerCase() === identity.display.toLowerCase()))
		prose.add(identity.display.toLowerCase());
	if (
		[...identity.mentionOnly, ...identity.recipientAliases].some((item) =>
			prose.has(item.toLowerCase()),
		)
	)
		throw new Error('An operator alias cannot be both a prose name and a role shorthand.');
	return identity;
}

export function operatorNames(identity: OperatorIdentity): string[] {
	return [
		identity.display,
		...identity.aliases,
		...identity.mentionOnly,
		...identity.recipientAliases,
	];
}
