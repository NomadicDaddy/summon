import { accessSync, constants, existsSync, lstatSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

/** Resolve only explicit absolute paths or absolute PATH entries; never search the working folder. */
export function resolveExecutable(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const environment = (key: string): string | undefined =>
		env[key] ??
		(process.platform === 'win32'
			? Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1]
			: undefined);
	const absolute = (path: string): boolean =>
		isAbsolute(path) &&
		(process.platform !== 'win32' ||
			/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(path));
	const executable = (path: string): boolean => {
		// Windows app-execution aliases (for example wt.exe) are executable reparse points
		// whose target cannot be opened with stat/access. Keep their explicit absolute path.
		if (process.platform === 'win32' && /\.exe$/i.test(path) && existsSync(path)) {
			try {
				if (lstatSync(path).isSymbolicLink()) return true;
			} catch {
				return false;
			}
		}
		try {
			if (!statSync(path).isFile()) return false;
			accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
	if (absolute(name)) return executable(name) ? name : undefined;
	if (!name || /[:\\/]/.test(name)) return undefined;
	const extensions =
		process.platform === 'win32' && !extname(name)
			? (environment('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
					.split(';')
					.filter((part) => /^\.[a-z0-9]+$/i.test(part))
			: [''];
	for (const entry of (environment('PATH') ?? '').split(delimiter)) {
		const directory = entry.replace(/^"|"$/g, '');
		if (!absolute(directory)) continue;
		for (const extension of extensions) {
			const path = join(directory, name + extension);
			if (executable(path)) return path;
		}
	}
	return undefined;
}

export function requireExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string {
	const path = resolveExecutable(name, env);
	if (!path)
		throw new Error(`${name} was not found on an absolute PATH entry; no program launched.`);
	return path;
}

export function executableCommand(
	command: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	return [requireExecutable(command[0] ?? '', env), ...command.slice(1)];
}
