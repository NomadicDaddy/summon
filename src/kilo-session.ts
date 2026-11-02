import { executableCommand } from './executable.ts';
import { sessionIdPattern } from './store.ts';

/** Allocate a provider-owned ID without inference or guessing from another session's history. */
export async function createKiloSession(
	cwd: string,
	env: NodeJS.ProcessEnv,
	onChild: (pid: number) => Promise<void>,
	command = ['kilo', 'acp', '--cwd', cwd],
): Promise<string> {
	const child = (() => {
		try {
			return Bun.spawn({
				cmd: executableCommand(command, env),
				cwd,
				env,
				windowsHide: true,
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'ignore',
			});
		} catch {
			throw new Error('Cannot start Kilo. Install the kilo CLI and check PATH.');
		}
	})();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const send = async (id: number, method: string, params: object): Promise<void> => {
		await child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
	};
	try {
		await onChild(child.pid);
		await send(1, 'initialize', {
			protocolVersion: 1,
			clientCapabilities: {},
			clientInfo: { name: 'summon', version: '1' },
		});
		const read = async (): Promise<string> => {
			let buffer = '';
			let initialized = false;
			const decoder = new TextDecoder();
			for await (const chunk of child.stdout) {
				buffer += decoder.decode(chunk, { stream: true });
				if (buffer.length > 2_000_000)
					throw new Error('Kilo session response exceeded its limit.');
				let index: number;
				while ((index = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 1);
					let value: unknown;
					try {
						value = JSON.parse(line) as unknown;
					} catch {
						continue;
					}
					if (!value || typeof value !== 'object') continue;
					const message = value as Record<string, unknown>;
					if (message.id !== 1 && message.id !== 2) continue;
					if (message.error)
						throw new Error('Kilo rejected session creation; check its configuration.');
					if (message.id === 1 && !initialized) {
						const result = message.result as { protocolVersion?: unknown } | undefined;
						if (result?.protocolVersion !== 1)
							throw new Error('Kilo returned an unsupported ACP version.');
						initialized = true;
						await send(2, 'session/new', { cwd, mcpServers: [] });
					} else if (message.id === 2 && initialized) {
						const result = message.result as { sessionId?: unknown } | undefined;
						const id = result?.sessionId;
						if (typeof id !== 'string' || !sessionIdPattern.test(id))
							throw new Error('Kilo returned an invalid session ID.');
						return id;
					}
				}
			}
			throw new Error('Kilo exited before creating a session.');
		};
		return await Promise.race([
			read(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error('Kilo session creation timed out.')),
					45000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
		child.kill();
		await child.exited;
	}
}
