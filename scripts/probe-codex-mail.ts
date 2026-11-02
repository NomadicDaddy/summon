// Opt-in hook check. Full live acceptance still requires an interactive Codex session.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { missing } from '../src/mail-files.ts';
import { codexHookOverride } from '../src/mail-session-hook.ts';

const root = await mkdtemp(join(tmpdir(), 'summon-codex-probe-'));
const nonce = randomUUID();
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
console.log(`Disposable hook records: ${root}`);
const child = Bun.spawn({
	cmd: [
		'codex',
		'exec',
		'-c',
		codexHookOverride(),
		'Reply only MAIL_PROBE_OK. This is a hook acceptance probe. Do not use tools or access mail.',
	],
	env: { ...process.env, SUMMON_HOME: root, SUMMON_AGENT: 'probe', SUMMON_NONCE: nonce },
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
try {
	console.log(
		`Trusted hook bound: ${await readFile(join(root, 'runtime/probe', `${nonce}.binding`), 'utf8')}`,
	);
} catch (error: unknown) {
	if (!missing(error)) throw error;
	console.log(
		'No root-session binding observed. Review the hook in the provider before live acceptance.',
	);
}
