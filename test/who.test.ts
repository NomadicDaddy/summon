import { expect, test } from 'bun:test';

import { isSessionHost } from '../skills/summon-who/scripts/hosts.ts';

test('recognizes team-window and terminal hosts without accepting unrelated processes', () => {
	for (const name of ['electron.exe', 'Electron', 'WindowsTerminal.exe'])
		expect(isSessionHost(name)).toBe(true);
	expect(isSessionHost('explorer.exe')).toBe(false);
});
