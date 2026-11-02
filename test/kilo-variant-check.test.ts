import { expect, test } from 'bun:test';

import { checkKiloVariant, variantsFromListing } from '../src/kilo-variant-check.ts';

const usage = 'usage';
/** The refusal message, or 'accepted' when the check let it through. */
const refusal = (work: Promise<unknown>): Promise<string> =>
	work.then(
		() => 'accepted',
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
const lists = (variants: string[]) => {
	const calls: string[] = [];
	const list = (model: string) => {
		calls.push(model);
		return Promise.resolve({ variants });
	};
	return { calls, list };
};

test('the kilo models listing gives each model its variant names', () => {
	const stdout = [
		'zai-coding-plan/glm-5.3',
		'{',
		'  "id": "glm-5.3",',
		'  "variants": { "low": {}, "high": { "reasoningEffort": "high" }, "max": {} }',
		'}',
		'zai-coding-plan/glm-5.3-flash',
		'{ "id": "glm-5.3-flash" }',
	].join('\n');
	expect(variantsFromListing(stdout, 'zai-coding-plan/glm-5.3')).toEqual(['low', 'high', 'max']);
	expect(variantsFromListing(stdout, 'zai-coding-plan/glm-5.3-flash')).toEqual([]);
	expect(variantsFromListing(stdout, 'zai-coding-plan/other')).toBeUndefined();
});

test('a variant the model does not list is refused when it is set', async () => {
	const { list } = lists(['low', 'high']);
	expect(await refusal(checkKiloVariant('kilo', 'zai/glm', 'max', undefined, usage, list))).toBe(
		'zai/glm does not list the reasoning variant max; it lists low, high.',
	);
	expect(
		await checkKiloVariant('kilo', 'zai/glm', 'high', undefined, usage, list),
	).toBeUndefined();
});

test('when Kilo cannot answer, the setting is kept and the note says the check was skipped', async () => {
	const skipped = () => Promise.resolve({ skipped: "Kilo's model list could not be read" });
	expect(await checkKiloVariant('kilo', 'zai/glm', 'high', undefined, usage, skipped)).toBe(
		"Reasoning variant high saved without a check: Kilo's model list could not be read.",
	);
});

test('an unchanged model and variant are not checked again; a model change re-checks the kept one', async () => {
	const unchanged = lists(['high']);
	const saved = { model: 'zai/glm', variant: 'high' };
	expect(
		await checkKiloVariant('kilo', 'zai/glm', 'high', saved, usage, unchanged.list),
	).toBeUndefined();
	expect(
		await checkKiloVariant('kilo', 'zai/glm', undefined, saved, usage, unchanged.list),
	).toBeUndefined();
	expect(unchanged.calls).toEqual([]);
	const moved = lists(['low']);
	expect(
		await refusal(checkKiloVariant('kilo', 'zai/new', undefined, saved, usage, moved.list)),
	).toContain('does not list the reasoning variant high');
	expect(moved.calls).toEqual(['zai/new']);
});

test('clearing, other providers and an invalid request never reach the catalog', async () => {
	const { calls, list } = lists([]);
	expect(
		await checkKiloVariant('kilo', 'zai/glm', '', { variant: 'high' }, usage, list),
	).toBeUndefined();
	expect(
		await checkKiloVariant('claude', undefined, undefined, undefined, usage, list),
	).toBeUndefined();
	expect(
		await refusal(checkKiloVariant('codex', 'zai/glm', 'high', undefined, usage, list)),
	).toBe(usage);
	expect(calls).toEqual([]);
});
