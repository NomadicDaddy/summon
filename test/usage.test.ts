import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { codexUsage, usageLines } from '../src/desktop/usage.ts';

test('usage adapter performs only initialized read RPCs and labels account versus session estimates', async () => {
	const report = await codexUsage('fixture-session', [
		process.execPath,
		resolve('test/fixtures/usage-server.ts'),
	]);
	expect(report.lines.join('\n')).toContain('75% remaining');
	expect(report.lines.join('\n')).toContain('shared account allowance');
	expect(report.lines.join('\n')).toContain('ordinary included usage: no');
	expect(report.lines.join('\n')).toContain('1,234');
	expect(report.lines.join('\n')).toContain('$0.2500');
	expect(report.lines.join('\n')).not.toContain('unavailable');
});
test('missing usage values stay unknown, invalid percentages never imply unlimited capacity', () => {
	expect(
		usageLines({ rateLimits: { primary: { usedPercent: 33.333333333 } } }, null).join('\n'),
	).toContain('66.7% remaining');
	expect(usageLines(null, null)).toEqual([
		'Account limits: unavailable from this provider response.',
		'Session tokens: unavailable.',
		'Session cost: unavailable.',
	]);
	expect(
		usageLines({ rateLimits: { primary: { usedPercent: -1 } } }, null).join('\n'),
	).not.toContain('remaining');
});
