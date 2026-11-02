// Only a disposable CLI test preload: production has no override for the integrity check.
import { mock } from 'bun:test';

import { assertMediumIntegrity } from '../../src/windows-integrity.ts';

void mock.module('../../src/windows-integrity.ts', () => ({
	assertMediumIntegrity,
	assertNonElevated: () => Promise.resolve(assertMediumIntegrity('S-1-16-12288')),
}));
