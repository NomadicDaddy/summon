import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The test archives and the local download server behind the prerequisite helper tests. Archives
// are served by name; the prefixed routes misbehave in the ways a real download can, so the
// helper's bounds are measured.
export type Transfer = 'offline' | 'stall' | 'trickle' | 'late';

export const powershell = join(
	process.env.SystemRoot ?? 'C:\\Windows',
	'System32/WindowsPowerShell/v1.0/powershell.exe',
);

export async function powershellRun(command: string): Promise<void> {
	const child = Bun.spawn([powershell, '-NoProfile', '-NonInteractive', '-Command', command], {
		stdout: 'ignore',
		stderr: 'pipe',
		windowsHide: true,
	});
	if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
}

/** Builds <root>\<name>.zip from the given files with 5.1's Compress-Archive. */
export async function zip(
	root: string,
	name: string,
	files: Record<string, string | Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
	const source = join(root, `zip-${name}`);
	for (const [path, contents] of Object.entries(files)) {
		await mkdir(join(source, path, '..'), { recursive: true });
		await writeFile(join(source, path), contents);
	}
	const target = join(root, `${name}.zip`);
	await powershellRun(
		`Compress-Archive -Path '${join(source, '*')}' -DestinationPath '${target}'`,
	);
	return new Uint8Array(await readFile(target));
}

/** A transfer whose first bytes arrive and whose body then never completes. */
function stalled(): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(1024));
			},
		}),
		{ headers: { 'content-length': '4096' } },
	);
}

/** One byte every 200 ms, always inside the stall timeout, never finishing. */
function trickle(): Response {
	let timer: ReturnType<typeof setInterval> | undefined;
	return new Response(
		new ReadableStream({
			start(controller) {
				timer = setInterval(() => controller.enqueue(new Uint8Array(1)), 200);
			},
			cancel() {
				clearInterval(timer);
			},
		}),
		{ headers: { 'content-length': '100000000' } },
	);
}

// Archives own plain ArrayBuffers (copied from file reads), which Response accepts as a body.
export function serveArchives(
	archives: Map<string, Uint8Array<ArrayBuffer>>,
	onRequest: () => void,
) {
	return Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			onRequest();
			const name = new URL(request.url).pathname.slice(1);
			if (name === 'stall/bun.zip') return stalled();
			if (name === 'trickle/bun.zip') return trickle();
			// A slow server: the answer comes 4 s in, then the body stalls.
			if (name === 'late/bun.zip') return Bun.sleep(4000).then(stalled);
			const body = archives.get(name);
			return body ? new Response(body) : new Response('missing', { status: 404 });
		},
	});
}
