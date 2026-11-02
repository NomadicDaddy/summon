import { expect, test } from 'bun:test';

import { parseOptions } from '../src/cli-options.ts';

test.each(['--expertise', '--domain'])('%s enforces the desktop profile limit', (option) => {
	expect(() => parseOptions(['Ember', option, 'x'.repeat(8001)])).toThrow('8000 characters');
	expect(() => parseOptions(['Ember', option, 'x'.repeat(8000)])).not.toThrow();
});
