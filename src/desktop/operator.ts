import type { IPtyForkOptions } from 'node-pty';

import type { ShellDefinition } from './shells.ts';
import type { TerminalProcess } from './team.ts';
import type { OperatorEvent } from './types.ts';

import {
	childEnvironment,
	killProcessTree,
	MAX_TERMINAL_INPUT,
	validTerminalSize,
} from './pty-process.ts';

/** An operator-owned shell, independent of agent identity and roster membership. */
export class OperatorTerminal {
	private pty: TerminalProcess | undefined;
	private stopping: Promise<void> | undefined;
	private closing = false;
	private readonly shells: ShellDefinition[];
	private readonly cwd: string;
	private readonly emit: (event: OperatorEvent) => void;
	private readonly terminate: typeof killProcessTree;
	private readonly spawn: (
		file: string,
		args: string[],
		options: IPtyForkOptions,
	) => TerminalProcess;
	constructor(
		shells: ShellDefinition[],
		cwd: string,
		emit: (event: OperatorEvent) => void,
		spawn: (file: string, args: string[], options: IPtyForkOptions) => TerminalProcess,
		terminate = killProcessTree,
	) {
		this.shells = shells;
		this.cwd = cwd;
		this.emit = emit;
		this.spawn = spawn;
		this.terminate = terminate;
	}

	start(id: string, cols: number, rows: number): void {
		if (this.closing || this.stopping) throw new Error('Terminal is stopping.');
		if (this.pty) throw new Error('Stop the current terminal before choosing another shell.');
		const shell = this.shells.find((value) => value.id === id);
		if (!shell) throw new Error('Unknown shell.');
		if (!validTerminalSize(cols, rows)) throw new Error('Invalid terminal size.');
		const env = childEnvironment();
		const pty = this.spawn(shell.path, shell.args, {
			cwd: this.cwd,
			env,
			cols,
			rows,
			name: 'xterm-256color',
		});
		this.pty = pty;
		this.emit({ type: 'started', shell: id, cwd: this.cwd });
		pty.onData((data) => this.emit({ type: 'output', data }));
		pty.onExit(({ exitCode }) => {
			if (this.pty !== pty) return;
			this.pty = undefined;
			this.emit({ type: 'exited', exitCode });
		});
	}

	input(data: string): void {
		if (data.length > MAX_TERMINAL_INPUT) throw new Error('Terminal input is too large.');
		this.pty?.write(data);
	}

	resize(cols: number, rows: number): void {
		if (validTerminalSize(cols, rows)) this.pty?.resize(cols, rows);
	}

	async stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		const pty = this.pty;
		if (!pty) return;
		this.stopping = (async () => {
			if (process.platform === 'win32') {
				await this.terminate(pty.pid, () => this.pty !== pty);
			} else pty.kill();
		})();
		try {
			await this.stopping;
		} finally {
			this.stopping = undefined;
		}
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		try {
			await this.stop();
		} catch (error: unknown) {
			this.cancelShutdown();
			throw error;
		}
	}

	/** Called after all close attempts settle when the window must remain open. */
	cancelShutdown(): void {
		this.closing = false;
	}
}
