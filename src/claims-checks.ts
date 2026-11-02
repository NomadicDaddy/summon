import { execFileSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { Claim, ClaimResult } from './claims-model.ts';

import { requireExecutable } from './executable.ts';
import { localEvents } from './local-room.ts';
import { canonicalPath, redirectedComponent } from './path-identity.ts';

const forbidden =
	/(?:^|[\\/])(?:secrets|\.git|\.codex|\.claude|\.summon|mailboxes|\.ssh|\.aws|\.wrangler|\.env(?:\..*)?)(?:[\\/]|$)|(?:credential|password|token|secret|private[-_]?key)/i;
const inside = (root: string, path: string): boolean => {
	const part = relative(root, path);
	return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
};

/** No network paths, private stores, junction escapes or alternate data streams. */
async function claimPath(path: unknown, root: string): Promise<string> {
	if (
		typeof path !== 'string' ||
		!isAbsolute(path) ||
		path.startsWith('\\\\') ||
		path.startsWith('//') ||
		forbidden.test(path) ||
		path.slice(2).includes(':')
	)
		throw new Error('Target is outside published-claim scope.');
	const base = await realpath(root);
	const target = resolve(path);
	// Containment is checked lexically first, against the root as written and as real, so a target
	// outside it is refused before anything on its path is probed.
	if (
		forbidden.test(base) ||
		forbidden.test(target) ||
		(!inside(resolve(root), target) && !inside(base, target))
	)
		throw new Error('Target must be inside the owner working directory.');
	// Links and redirected drives are refused on the path as written. A spelling alias (an 8.3 short
	// name) is neither, so the target's identity decides containment and the forbidden names.
	if (await redirectedComponent(target)) throw new Error('Links are not claim targets.');
	const identity = await canonicalPath(target);
	if (!inside(base, identity) || forbidden.test(identity))
		throw new Error('Target must be inside the owner working directory.');
	return target;
}

function command(file: string, args: string[]): string {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
	);
	return execFileSync(requireExecutable(file), args, {
		env: {
			...env,
			GIT_NO_LAZY_FETCH: '1',
			GIT_TERMINAL_PROMPT: '0',
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
		},
		encoding: 'utf8',
		timeout: 3000,
		maxBuffer: 8192,
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

export async function checkClaim(claim: Claim, root: string): Promise<ClaimResult> {
	const result = (state: ClaimResult['state'], reason: string): ClaimResult => ({
		id: claim.id,
		text: claim.text,
		state,
		reason,
		checkedAt: new Date().toISOString(),
	});
	const [kind, arg, value, literal] = claim.check;
	try {
		if (claim.duty && kind !== 'artifact-newer-than')
			return result('UNVERIFIABLE', 'Duties require an artifact-newer-than predicate.');
		let matches: boolean;
		if (
			kind === 'artifact-newer-than' &&
			claim.check.length === 3 &&
			typeof value === 'number' &&
			Number.isFinite(value) &&
			value > 0 &&
			value <= 365
		) {
			const stat = await lstat(await claimPath(arg, root));
			const age = Date.now() - stat.mtimeMs;
			if (!stat.isFile() || age < 0)
				return result(
					'UNVERIFIABLE',
					'Artifact must be a regular file without a future timestamp.',
				);
			return result(
				age <= value * 86400000 ? 'NOT-CONTRADICTED' : 'DISPUTED',
				'Checks artifact modification time only; it does not establish that the duty was performed.',
			);
		} else if (
			kind === 'room-message-says' &&
			claim.check.length === 3 &&
			Number.isSafeInteger(arg) &&
			typeof value === 'string' &&
			value.length > 0
		) {
			const event = (await localEvents()).find((item) => item.id === arg);
			matches = event?.sender.kind === 'user' && event.text.includes(value);
		} else if (kind === 'file-exists' && claim.check.length === 2) {
			const path = await claimPath(arg, root);
			try {
				await lstat(path);
			} catch (e: unknown) {
				if (e instanceof Error && 'code' in e && e.code === 'ENOENT')
					return result('DISPUTED', 'Declared path does not exist.');
				throw e;
			}
			return result(
				'WEAK',
				'Existence alone does not establish identity, current configuration or behavior.',
			);
		} else if (
			(kind === 'file-contains' && claim.check.length === 3) ||
			(kind === 'file-line-equals' && claim.check.length === 4)
		) {
			const path = await claimPath(arg, root);
			const stat = await lstat(path);
			if (!stat.isFile() || stat.size > 512000)
				return result('UNVERIFIABLE', 'Target is not a bounded text file.');
			const text = await readFile(path, 'utf8');
			if (text.includes('\0')) return result('UNVERIFIABLE', 'Binary target refused.');
			if (kind === 'file-contains' && typeof value === 'string' && value.length > 0)
				matches = text.includes(value);
			else if (
				kind === 'file-line-equals' &&
				Number.isSafeInteger(value) &&
				Number(value) > 0 &&
				typeof literal === 'string'
			)
				matches = text.split(/\r?\n/)[Number(value) - 1] === literal;
			else return result('UNVERIFIABLE', 'Invalid literal or line number.');
		} else if (
			kind === 'git-has-commit' &&
			claim.check.length === 3 &&
			typeof value === 'string' &&
			/^[a-f0-9]{40}$/i.test(value)
		) {
			const path = await claimPath(arg, root);
			try {
				command('git', [
					'--no-pager',
					'-c',
					'protocol.allow=never',
					'-c',
					'core.fsmonitor=false',
					'-C',
					path,
					'cat-file',
					'-e',
					`${value}^{commit}`,
				]);
				matches = true;
			} catch {
				return result(
					'UNVERIFIABLE',
					'Git could not confirm this commit; unavailable repository and missing commit are not distinguished.',
				);
			}
		} else if (
			kind === 'tool-version' &&
			claim.check.length === 3 &&
			(arg === 'bun' || arg === 'git') &&
			typeof value === 'string' &&
			/^\d+\.\d+\.\d+$/.test(value)
		) {
			const version = arg === 'bun' ? Bun.version : command('git', ['--version']);
			const actual = /\d+\.\d+\.\d+/.exec(version)?.[0];
			if (!actual) return result('UNVERIFIABLE', 'Tool did not provide a numeric version.');
			const parts = actual.split('.').map(Number),
				minimum = value.split('.').map(Number);
			const difference =
				parts.map((part, i) => part - (minimum[i] ?? 0)).find((part) => part !== 0) ?? 0;
			matches = difference >= 0;
		} else if (
			kind === 'env-equals' &&
			claim.check.length === 3 &&
			typeof arg === 'string' &&
			['LANG', 'TZ', 'NODE_ENV', 'BUN_ENV', 'XDG_CONFIG_HOME'].includes(arg) &&
			typeof value === 'string'
		) {
			if (process.platform !== 'win32')
				return result('UNVERIFIABLE', 'HKCU environment is available only on Windows.');
			const output = command(
				resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/reg.exe'),
				['query', 'HKCU\\Environment', '/v', arg],
			);
			const stored = /REG_(?:EXPAND_)?SZ\s+(.*)/.exec(output)?.[1];
			matches = stored === value;
		} else
			return result(
				'UNVERIFIABLE',
				'Unsupported predicate, unsafe environment name or invalid arguments.',
			);
		return result(
			matches ? 'NOT-CONTRADICTED' : 'DISPUTED',
			matches ? 'Declared predicate matched.' : 'Declared predicate did not match.',
		);
	} catch {
		return result(
			'UNVERIFIABLE',
			'Target inaccessible, outside scope, or check failed; no file contents or command output retained.',
		);
	}
}
