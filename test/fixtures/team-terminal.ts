// A disposable terminal workload for the interactive team-window probe, never a real agent.
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.env.SUMMON_HOME;
const name = process.argv[3];
if (!root?.includes('summon-team-probe-') || !name) throw new Error('Isolated probe required.');
const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
	stdin: 'ignore',
	stdout: 'ignore',
	stderr: 'ignore',
});
await writeFile(join(root, `${name}.pids`), JSON.stringify({ pid: process.pid, child: child.pid }));
await appendFile(join(root, 'launches.txt'), `${name}\n`);
console.log(`\x1b[32m${name}: disposable terminal ready\x1b[0m`);
console.log('Type a message. This fixture echoes input and runs no agent.');
process.stdin.setRawMode(true);
process.stdin.on('data', (chunk: Buffer) => {
	const text = chunk.toString();
	process.stdout.write(text);
	void appendFile(join(root, `${name}-input.txt`), text);
});
setInterval(() => {}, 1000);
