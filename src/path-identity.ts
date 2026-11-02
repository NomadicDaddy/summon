import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, parse, posix, resolve, win32 } from 'node:path';

const missing = (error: unknown): boolean =>
	error instanceof Error && 'code' in error && error.code === 'ENOENT';

/**
 * The first redirection on `path` as written, or undefined when there is none: a link or junction
 * at any existing component from the drive or filesystem root down, or a drive whose real root is
 * elsewhere (a subst drive, or a letter mapped to a network share). Spelling aliases (Windows 8.3
 * short names, letter case) are not redirections. Components after the first missing one cannot
 * exist, so the walk stops there.
 */
export async function redirectedComponent(path: string): Promise<string | undefined> {
	const written = resolve(path);
	const chain: string[] = [];
	for (let current = written; ; current = dirname(current)) {
		chain.unshift(current);
		if (dirname(current) === current) break;
	}
	for (const component of chain) {
		try {
			if ((await lstat(component)).isSymbolicLink()) return component;
		} catch (error: unknown) {
			if (missing(error)) break;
			throw error;
		}
	}
	return sameRoot(written, await canonicalPath(written)) ? undefined : parse(written).root;
}

/**
 * Whether a path's real identity stays on the root it is written on. A spelling alias keeps it
 * (case-insensitively on Windows); a subst drive, a letter mapped to a share or another root change
 * does not. This does not claim to recognise every way a volume can be redirected.
 */
export function sameRoot(written: string, canonical: string, platform = process.platform): boolean {
	const fold = (value: string) => (platform === 'win32' ? value.toLowerCase() : value);
	const root = (value: string) => (platform === 'win32' ? win32 : posix).parse(value).root;
	return fold(root(canonical)) === fold(root(written));
}

/**
 * The identity of `path`: the real path of its deepest existing ancestor joined with the components
 * that do not exist yet. It resolves spelling aliases but also follows redirections, so callers that
 * refuse them must check redirectedComponent first.
 */
export async function canonicalPath(path: string): Promise<string> {
	const rest: string[] = [];
	for (let current = resolve(path); ; current = dirname(current)) {
		try {
			return join(await realpath(current), ...rest);
		} catch (error: unknown) {
			if (!missing(error) || dirname(current) === current) throw error;
			rest.unshift(basename(current));
		}
	}
}
