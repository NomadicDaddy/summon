import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cliHarness } from './fixtures/cli-harness.ts';

let fixture: Awaited<ReturnType<typeof cliHarness>>;
let records: string;
beforeEach(async () => {
	fixture = await cliHarness();
	({ records } = fixture);
});
afterEach(async () => {
	await fixture.dispose();
});
const invoke = (...args: Parameters<typeof fixture.invoke>) => fixture.invoke(...args);
const FLAG = '--dangerously-load-development-channels';
const setting = () => join(records, 'settings', 'claude-delivery.json');
const withRoom = async () => {
	await mkdir(join(records, 'integrations'));
	await writeFile(
		join(records, 'integrations/telegram.json'),
		JSON.stringify({ botToken: '123:fake', chatId: '456' }),
	);
};

// Claude asks for its development-channel confirmation at every start, and no supported route
// removes that prompt for a channel Summon ships itself. A new team therefore starts Claude without
// the flag; an existing team keeps the live delivery it already had.
describe('Claude delivery setting', () => {
	test('unavailable native observation preserves provider launch and explicit checkpoint tools', async () => {
		const result = await invoke(['member', '--same-window'], {
			SUMMON_TEST_CLAUDE_BRIDGE_FAILURE: '1',
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toContain(
			'Claude native observation unavailable; ordinary notices remain queued.',
		);
		expect(result.launches[0]?.cmd).toContain('--mcp-config');
		expect(result.launches[0]?.cmd).not.toContain('--plugin-dir');
	});
	test.each(['0', '1'])(
		'Exit before readiness does not poison the next launch (%s)',
		async (code) => {
			const declined = await invoke(['member', '--same-window', '--claude-mail-channel'], {
				SUMMON_TEST_CLAUDE_NO_READY: '1',
				SUMMON_TEST_EXIT: code,
			});
			expect(declined.code).toBe(Number(code));
			expect(declined.stderr).toContain('Claude closed before confirming launch readiness');
			expect((await fixture.saved()).sessions).toEqual([]);
			const retry = await invoke(['member', '--same-window', '--claude-mail-channel']);
			expect(retry.code).toBe(0);
			expect(retry.launches[0]?.cmd).toContain('--session-id');
			expect(retry.launches[0]?.cmd).not.toContain('--resume');
			expect(retry.launches[0]?.cmd[2]).not.toBe(declined.launches[0]?.cmd[2]);
			const id = retry.launches[0]?.cmd[2];
			if (!id) throw new Error('Expected a fresh Claude conversation ID.');
			expect((await fixture.saved()).sessions[0]?.id).toBe(id);
			const resumed = await invoke(['member', '--same-window', '--claude-mail-channel']);
			expect(resumed.launches[0]?.cmd.slice(0, 3)).toEqual(['claude', '--resume', id]);
		},
	);

	test('Exit on resume preserves the established conversation', async () => {
		const original = await fixture.seed('claude');
		const id = original.sessions[0]?.id;
		if (!id) throw new Error('Expected an established Claude conversation ID.');
		const declined = await invoke(['member', '--same-window', '--claude-mail-channel'], {
			SUMMON_TEST_CLAUDE_NO_READY: '1',
			SUMMON_TEST_EXIT: '1',
		});
		expect(declined.code).toBe(1);
		expect((await fixture.saved()).sessions[0]?.id).toBe(id);
		const retry = await invoke(['member', '--same-window', '--claude-mail-channel']);
		expect(retry.launches[0]?.cmd.slice(0, 3)).toEqual(['claude', '--resume', id]);
	});

	test('checkpoint Exit before readiness also retries with a fresh conversation', async () => {
		const declined = await invoke(['member', '--same-window'], {
			SUMMON_TEST_CLAUDE_NO_READY: '1',
			SUMMON_TEST_EXIT: '1',
		});
		expect(declined.code).toBe(1);
		expect(declined.launches[0]?.cmd).not.toContain('--dangerously-load-development-channels');
		expect((await fixture.saved()).sessions).toEqual([]);
		const retry = await invoke(['member', '--same-window']);
		expect(retry.code).toBe(0);
		expect(retry.launches[0]?.cmd).toContain('--session-id');
		expect(retry.launches[0]?.cmd).not.toContain('--resume');
	});

	test('the first teammate of an empty team records checkpoint delivery', async () => {
		const created = await invoke(['member', '--same-window']);
		expect(created.code).toBe(0);
		expect(JSON.parse(await readFile(setting(), 'utf8'))).toEqual({
			version: 1,
			mode: 'checkpoint',
		});
		expect(created.launches[0]?.cmd).not.toContain(FLAG);
	});

	test('a new team does not ask for the channel even once it has a room', async () => {
		expect((await invoke(['member', '--same-window'])).code).toBe(0);
		await withRoom();
		for (const args of [
			['member', '--same-window'],
			['__session', 'member'],
		]) {
			const result = await invoke(args);
			expect(result.code).toBe(0);
			expect(result.launches[0]?.cmd).not.toContain(FLAG);
			// The mail server still loads as ordinary tools; only pushed notices are off.
			expect(result.launches[0]?.cmd).toContain('--mcp-config');
			expect(result.stdout).not.toContain('development channel');
		}
	});

	test('an existing team with no setting keeps live delivery and is not rewritten', async () => {
		await fixture.seed('claude');
		await withRoom();
		const result = await invoke(['member', '--same-window']);
		expect(result.code).toBe(0);
		expect(result.launches[0]?.cmd).toContain(FLAG);
		expect(await Bun.file(setting()).exists()).toBe(false);
		// A second teammate joining that team does not turn it into a new one.
		expect((await invoke(['second', '--same-window'])).code).toBe(0);
		expect(await Bun.file(setting()).exists()).toBe(false);
	});

	test('the explicit launch option wins over checkpoint, for that launch only', async () => {
		expect((await invoke(['member', '--same-window'])).code).toBe(0);
		const explicit = await invoke(['member', '--same-window', '--claude-mail-channel']);
		expect(explicit.launches[0]?.cmd).toContain(FLAG);
		expect(explicit.launches[0]?.cmd).toContain('server:summon-mail');
		const ordinary = await invoke(['member', '--same-window']);
		expect(ordinary.launches[0]?.cmd).not.toContain(FLAG);
	});

	test('the window checkpoint selection survives a changed team setting before launch', async () => {
		await fixture.seed('claude');
		await withRoom();
		const result = await invoke(['__session', 'member', '--claude-checkpoint']);
		expect(result.code).toBe(0);
		expect(result.launches[0]?.cmd).not.toContain(FLAG);
		const command = result.launches[0]?.cmd ?? [];
		const config = JSON.parse(command[command.indexOf('--mcp-config') + 1] ?? '{}') as {
			mcpServers: { 'summon-mail': { env: { SUMMON_CLAUDE_CHANNEL: string } } };
		};
		expect(config.mcpServers['summon-mail'].env.SUMMON_CLAUDE_CHANNEL).toBe('0');
	});

	test('a live launch explains the confirmation before Claude shows it', async () => {
		await fixture.seed('claude');
		await withRoom();
		const result = await invoke(['member', '--same-window']);
		expect(result.stdout).toContain('server:summon-mail');
		expect(result.stdout).toContain('Choosing Exit closes Claude.');
		expect(result.stdout).toContain('summon --claude-delivery checkpoint');
	});

	test('the operator can read and change the setting, and it takes effect at the next start', async () => {
		await fixture.seed('claude');
		await withRoom();
		expect((await invoke(['--claude-delivery'])).stdout).toContain('Claude delivery: live');
		expect((await invoke(['--claude-delivery', 'checkpoint'])).code).toBe(0);
		expect((await invoke(['--claude-delivery'])).stdout).toContain(
			'Claude delivery: checkpoint',
		);
		expect((await invoke(['member', '--same-window'])).launches[0]?.cmd).not.toContain(FLAG);
		expect((await invoke(['--claude-delivery', 'live'])).code).toBe(0);
		expect((await invoke(['member', '--same-window'])).launches[0]?.cmd).toContain(FLAG);
	});

	test('an unknown mode and a damaged file are refused rather than guessed at', async () => {
		const unknown = await invoke(['--claude-delivery', 'sometimes']);
		expect(unknown.code).not.toBe(0);
		expect(unknown.stderr).toContain('Usage: summon --claude-delivery');
		await fixture.seed('claude');
		// The setting is read once there is a room to deliver from.
		await withRoom();
		await mkdir(join(records, 'settings'), { recursive: true });
		await writeFile(setting(), JSON.stringify({ version: 1, mode: 'sometimes' }));
		const launched = await invoke(['member', '--same-window']);
		expect(launched.code).not.toBe(0);
		expect(launched.stderr).toContain('Invalid Claude delivery configuration.');
		expect(launched.launches).toHaveLength(0);
	});
});
