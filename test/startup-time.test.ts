import { expect, test } from 'bun:test';

test.each([
	['America/Chicago', '2026-09-30T01:41:00Z', '2026-09-29 20:41:00 UTC-05:00'],
	['America/Chicago', '2026-01-30T01:41:00Z', '2026-01-29 19:41:00 UTC-06:00'],
	['Asia/Kathmandu', '2026-09-30T01:41:00Z', '2026-09-30 07:26:00 UTC+05:45'],
	['UTC', '2026-09-30T00:00:00Z', '2026-09-30 00:00:00 UTC+00:00'],
])('startup prompt uses host zone %s at %s', async (zone, instant, expected) => {
	const child = Bun.spawn(
		[
			process.execPath,
			'-e',
			`import { setSystemTime } from 'bun:test';
		import { sessionPrompt } from './src/providers.ts';
		import { newRecord } from './src/store.ts';
		setSystemTime(new Date(${JSON.stringify(instant)}));
		console.log(sessionPrompt(newRecord('Clock', '/work', 'codex'), 'clock'));`,
		],
		{ env: { ...process.env, TZ: zone }, stdout: 'pipe', stderr: 'pipe' },
	);
	const output = await new Response(child.stdout).text();
	expect(await child.exited).toBe(0);
	expect(output).toContain(`Local time at session startup: ${expected}.`);
	expect(output).toContain('Machine time zone:');
	expect(output).toContain('Timestamps ending in Z are UTC');
});
