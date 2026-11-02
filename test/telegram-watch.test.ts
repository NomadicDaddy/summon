import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('operator watch survives transient Telegram failures without repeating diagnostics', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-watch-'));
	await mkdir(join(root, 'integrations'));
	await writeFile(
		join(root, 'integrations/telegram.json'),
		JSON.stringify({ botToken: '123:fake', chatId: '456' }),
	);
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			'--preload',
			resolve('test/fixtures/telegram-fetch.ts'),
			resolve('src/cli.ts'),
			'--telegram',
			'watch',
		],
		env: { ...process.env, SUMMON_HOME: root, SUMMON_TEST_TELEGRAM: 'network' },
		stdout: 'pipe',
		stderr: 'pipe',
		stdin: 'ignore',
		windowsHide: true,
	});
	const error = new Response(child.stderr).text();
	try {
		await Bun.sleep(3200);
		expect(child.exitCode).toBeNull();
	} finally {
		child.kill();
		await child.exited;
		await rm(root, { recursive: true, force: true });
	}
	expect((await error).match(/Telegram request could not be confirmed/g)).toHaveLength(1);
}, 10000);
