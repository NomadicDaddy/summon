import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { teamSnapshot } from '../src/desktop/team-snapshot.ts';
import { newRecord, saveAgent } from '../src/store.ts';

/*
 * The PM is marked in the roster and the session header (#5734). The mark follows the stored role
 * alone: a member named Steward is not a PM by its name, and a rest-stop grant is not a role.
 */
test('the snapshot carries the stored role and nothing else decides it', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-pm-indicator-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		await saveAgent('coordinator', {
			...newRecord('coordinator', root, 'claude'),
			memberType: 'pm',
			displayName: 'Coord',
		});
		await saveAgent('steward', {
			...newRecord('steward', root, 'codex'),
			canStopResting: true,
		});
		await saveAgent('legacy', newRecord('legacy', root, 'codex'));
		const { agents } = await teamSnapshot({
			sessions: new Map(),
			reported: new Set<string>(),
			emit: () => {},
			startedAt: new Date().toISOString(),
			selected: '',
		});
		const role = Object.fromEntries(agents.map((agent) => [agent.slug, agent.memberType]));
		expect(role).toEqual({ coordinator: 'pm', legacy: 'teammate', steward: 'teammate' });
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test('the roster row and the session header both read memberType', async () => {
	const row = await Bun.file('src/desktop/member-identity.ts').text();
	expect(row).toContain("if (agent.memberType === 'pm') name.after(roleTag());");
	const renderer = await Bun.file('src/desktop/renderer.ts').text();
	expect(renderer).toContain("element('name-role').hidden = selected?.memberType !== 'pm';");
	const html = await Bun.file('src/desktop/index.html').text();
	expect(html).toContain('<span id="name-role" class="role-tag" hidden>Project manager</span>');
});
