/** Remove every Summon seat or storage variable before launching an unowned tool. */
export function scrubSummonEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined && !key.toUpperCase().startsWith('SUMMON_')) {
			environment[key] = value;
		}
	}
	return environment;
}

/** Run a command without a Summon seat. Descendants inherit the same scrubbed environment. */
export async function unownedCommand(args: string[]): Promise<void> {
	if (args[0] !== '--' || !args[1])
		throw new Error('Usage: summon --unowned -- <executable> [arguments...]');
	const child = Bun.spawn(args.slice(1), {
		cwd: process.cwd(),
		env: scrubSummonEnvironment(process.env),
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
		windowsHide: true,
	});
	process.exitCode = await child.exited;
}
