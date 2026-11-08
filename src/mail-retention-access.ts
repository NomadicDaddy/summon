import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const readySchema = z.object({
	ready: z.literal(true),
	present: z.array(z.boolean()),
	canonical: z.array(z.string().nullable()),
});

/** Anchor access to held directory/file objects, permitting ordinary directory writers.
 * Production filesystem reads run through observe in the guarding worker itself.
 * Missing leaves must not be accessed, even if another process creates them later.
 * No portable path-only fallback is safe; unsupported platforms fail closed.
 */
export async function withRetentionPaths<T>(
	paths: string[],
	access: (
		present: boolean[],
		observe: (offset: number) => Promise<unknown>,
		canonical: (string | null)[],
	) => Promise<T>,
): Promise<T> {
	if (process.platform !== 'win32')
		throw new Error('Retention preview requires Windows and PowerShell 7.6 path guards.');
	const child = Bun.spawn({
		cmd: [
			'pwsh',
			'-NoLogo',
			'-NoProfile',
			'-NonInteractive',
			'-File',
			fileURLToPath(new URL('../scripts/retention-path-guard.ps1', import.meta.url)),
		],
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	const stderr = new Response(child.stderr).text();
	const reader = child.stdout.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const readLine = async (limit: number) => {
		const decoder = new TextDecoder('utf-8', { fatal: true });
		const parts: string[] = [];
		let length = 0;
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done)
				throw new Error(`Retention path guard failed before access. ${await stderr}`);
			const part = decoder.decode(chunk.value, { stream: true });
			length += part.length;
			if (length > limit) throw new Error('Invalid retention guard response.');
			parts.push(part);
			if (part.includes('\n')) return JSON.parse(parts.join('').trim()) as unknown;
		}
	};
	try {
		await child.stdin.write(
			`${JSON.stringify({ paths: paths.map((path) => resolve(path)) })}\n`,
		);
		await child.stdin.flush();
		const startup = async () => {
			const record = readySchema.parse(await readLine(4096));
			if (record.present.length !== paths.length || record.canonical.length !== paths.length)
				throw new Error('Incomplete retention path guard response.');
			return record;
		};
		const readiness = await Promise.race([
			startup(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('Retention path guard timed out.')),
					15000,
				);
			}),
		]);
		clearTimeout(timer);
		let observed = false;
		const value = await access(
			readiness.present,
			async (offset) => {
				if (observed) throw new Error('Only one guarded observation is allowed.');
				observed = true;
				await child.stdin.write(`${JSON.stringify({ offset })}\n`);
				await child.stdin.flush();
				return Promise.race([
					readLine(32_000_000),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error('Retention observation timed out.')),
							30000,
						);
					}),
				]);
			},
			readiness.canonical,
		);
		await child.stdin.write('release\n');
		await child.stdin.end();
		if ((await child.exited) !== 0)
			throw new Error('Retention path guard lost; result refused.');
		return value;
	} finally {
		clearTimeout(timer);
		// Only this worker, never a session, provider or other process.
		await child.stdin.end();
		if (child.exitCode === null) child.kill();
		await child.exited;
		await stderr;
		reader.releaseLock();
	}
}
