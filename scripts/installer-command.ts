import { executableCommand } from '../src/executable.ts';

export async function run(command: string[], cwd: string): Promise<void> {
	const child = Bun.spawn(executableCommand(command), {
		cwd,
		stdout: 'inherit',
		stderr: 'inherit',
		stdin: 'ignore',
		windowsHide: true,
	});
	if ((await child.exited) !== 0) throw new Error(`Failed: ${command[0]}`);
}
