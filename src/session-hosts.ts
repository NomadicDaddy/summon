const hosts = new Set([
	'electron',
	'windowsterminal',
	'wt',
	'openconsole',
	'pwsh',
	'powershell',
	'cmd',
	'bash',
	'sh',
	'zsh',
	'fish',
	'osascript',
	'terminal',
	'iterm2',
	'gnome-terminal',
	'gnome-terminal-server',
	'konsole',
	'x-terminal-emulator',
	'xterm',
	'wezterm',
	'wezterm-gui',
	'alacritty',
	'kitty',
]);

export function program(name: string): string {
	return name.replace(/\.exe$/i, '').toLowerCase();
}

export function isSessionHost(processName: string): boolean {
	return hosts.has(program(processName));
}
