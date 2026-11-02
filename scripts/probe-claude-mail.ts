// Opt-in provider acceptance. Uses disposable records and never touches registered mailboxes.
// --print cannot answer Claude's development-channel trust dialog, so a missing ready file
// does not by itself prove the channel transport failed.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { newRecord } from '../src/store.ts';

const root = await mkdtemp(join(tmpdir(), 'summon-live-probe-'));
const nonce = randomUUID();
await writeFile(join(root, 'probe.json'), JSON.stringify(newRecord('probe', root, 'claude')));
await mkdir(join(root, 'runtime/probe'), { recursive: true });
await writeFile(
	join(root, 'runtime/probe', `${nonce}.json`),
	JSON.stringify({
		nonce,
		pid: process.pid,
		state: 'queued-only',
		thread: '',
		reason: 'Probe starting.',
	}),
);
const configuration = JSON.stringify({
	mcpServers: {
		'summon-mail': {
			command: process.execPath,
			args: [resolve(import.meta.dir, '../src/claude-mail-channel.ts')],
			env: { SUMMON_HOME: root, SUMMON_AGENT: 'probe', SUMMON_NONCE: nonce },
		},
	},
});
console.log(`Disposable acceptance records: ${root}`);
const child = Bun.spawn({
	cmd: [
		'claude',
		'--print',
		'--no-session-persistence',
		'--mcp-config',
		configuration,
		'--dangerously-load-development-channels',
		'server:summon-mail',
		'--',
		'This is a summon transport acceptance check. Do not read any mail or perform tasks. If a channel readiness event arrives, acknowledge its nonce using the summon-mail mail tool. Then report whether the event arrived. Do not infer receipt from tool availability or this prompt.',
	],
	cwd: root,
	stdin: 'ignore',
	stdout: 'inherit',
	stderr: 'inherit',
	windowsHide: true,
});
const timeout = setTimeout(() => child.kill(), 60000);
try {
	console.log(`Provider exit: ${await child.exited}`);
} finally {
	clearTimeout(timeout);
}
console.log(await readFile(join(root, 'runtime/probe', `${nonce}.json`), 'utf8'));
