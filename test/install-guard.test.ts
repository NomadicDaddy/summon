import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('installation guard accepts Bun and rejects another package manager', async () => {
	for (const manager of ['bun/1.4.2', 'npm/11.0.0']) {
		const child = Bun.spawn({
			cmd: [process.execPath, resolve('scripts/require-bun.ts')],
			env: { ...process.env, npm_config_user_agent: manager },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(code).toBe(manager.startsWith('bun/') ? 0 : 1);
		if (code) expect(error).toContain('Use "bun install"');
	}
});
