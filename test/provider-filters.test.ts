import { expect, test } from 'bun:test';

import { providerFilterState } from '../src/desktop/provider-filters.ts';

test('only a Found CLI permits filtering, including a failed or pending check', () => {
	for (const status of ['missing', 'unavailable', undefined] as const) {
		expect(providerFilterState(false, status)).toEqual({ disabled: true, hidden: false });
		expect(providerFilterState(true, status)).toEqual({ disabled: true, hidden: false });
	}
	expect(providerFilterState(false, 'available')).toEqual({ disabled: false, hidden: false });
	expect(providerFilterState(true, 'available')).toEqual({ disabled: false, hidden: true });
});

test('losing availability reveals saved-hidden teammates without discarding their preference', () => {
	const savedHidden = true;
	expect(providerFilterState(savedHidden, 'available').hidden).toBe(true);
	expect(providerFilterState(savedHidden, 'missing').hidden).toBe(false);
	expect(providerFilterState(savedHidden, undefined).disabled).toBe(true);
	expect(providerFilterState(savedHidden, 'available').hidden).toBe(true);
});
