import { afterEach, beforeEach, expect, test } from 'bun:test';

import { initializeActivity } from '../src/agent-activity.ts';
import { codexHookOverride } from '../src/mail-session-hook.ts';
import { loadAgent, updateAgentRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const oldHome = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	await fixture.dispose();
});

test.skipIf(process.platform !== 'win32')(
	'Windows hook command binds through PowerShell with stdin intact and saves before returning',
	async () => {
		await updateAgentRecord('beta', (record) => {
			record.provider = 'codex';
		});
		await initializeActivity('beta', 'test-launch', 'codex');
		const hooks = Bun.TOML.parse(codexHookOverride()) as {
			hooks: { SessionStart: { hooks: { command_windows: string }[] }[] };
		};
		const command = hooks.hooks.SessionStart[0]?.hooks[0]?.command_windows;
		if (!command) throw new Error('Missing Windows hook command.');
		const child = Bun.spawn(['pwsh', '-NoProfile', '-NonInteractive', '-Command', command], {
			cwd: fixture.root,
			env: {
				...process.env,
				SUMMON_HOME: fixture.records,
				SUMMON_AGENT: 'beta',
				SUMMON_NONCE: 'test-launch',
			},
			stdin: new Blob([
				JSON.stringify({
					hook_event_name: 'SessionStart',
					source: 'startup',
					session_id: 'thread-shell-test',
				}),
			]),
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		});
		const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(error).toBe('');
		expect(code).toBe(0);
		expect(await fixture.read('runtime/beta/test-launch.binding')).toBe('thread-shell-test');
		expect((await loadAgent('beta'))?.sessions.at(-1)?.id).toBe('thread-shell-test');
	},
	// Allow cold pwsh startup without weakening the original encoded-hook assertions.
	15_000,
);
