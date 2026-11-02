import { mock, spyOn } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [root, outcome = 'success', version = '7.1.1', stream = 'stdout'] = process.argv.slice(2);
if (!root) throw new Error('Provide the disposable installer fixture root.');
// Only a synthetic Bun child runs. The retained result supplies the real process-result shape.
const result = Bun.spawnSync([process.execPath, '-e', 'process.exit(0)'], {
	windowsHide: true,
	timeout: 5000,
});
if (!result.success) throw new Error('Synthetic process control failed.');
result.stdout = Buffer.from(stream === 'stdout' ? version : '');
result.stderr = Buffer.from(stream === 'stderr' ? version : '');
result.exitCode = outcome === 'nonzero' || outcome === 'inconsistent-exit' ? 7 : 0;
result.success = outcome === 'success' || outcome.startsWith('inconsistent-');
if (outcome === 'signal' || outcome === 'inconsistent-signal') result.signalCode = 'SIGTERM';
spyOn(Bun, 'spawnSync').mockImplementationOnce(() => {
	if (outcome === 'unavailable') throw new Error('Synthetic compiler unavailable');
	return result;
});
await mock.module(join(root, 'scripts/installer-command.ts'), () => ({
	run: (command: string[]) => {
		writeFileSync(join(root, 'build-reached.json'), JSON.stringify(command));
		return Promise.reject(new Error('Controlled build boundary; no real build performed'));
	},
}));
process.env.SUMMON_ISCC = process.execPath;
await import(join(root, 'scripts/build-installer.ts'));
