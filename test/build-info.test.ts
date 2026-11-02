import { expect, test } from 'bun:test';

import { localBuildTime } from '../src/desktop/build-info.ts';

const instant = new Date('2026-10-14T13:31:05.123Z');

test('the build time is shown on the viewing machine clock, with its zone named', () => {
	expect(localBuildTime(instant, 'America/Chicago')).toBe('2026-10-14 08:31:05 CDT');
	expect(localBuildTime(instant, 'UTC')).toBe('2026-10-14 13:31:05 UTC');
});

test('midnight reads as 00, and the date follows the viewer across a day boundary', () => {
	const late = new Date('2026-10-15T04:00:00.000Z');
	expect(localBuildTime(late, 'UTC')).toBe('2026-10-15 04:00:00 UTC');
	expect(localBuildTime(late, 'America/Chicago')).toBe('2026-10-14 23:00:00 CDT');
	expect(localBuildTime(new Date('2026-10-15T05:00:00.000Z'), 'America/Chicago')).toBe(
		'2026-10-15 00:00:00 CDT',
	);
});
