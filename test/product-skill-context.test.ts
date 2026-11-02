import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { CHECKPOINT_STARTUP_INSTRUCTION } from '../src/checkpoint-work.ts';
import { skillContext } from '../src/skills.ts';

test('startup locates product communication skills without imposing a fleet workflow', async () => {
	const context = await skillContext();
	for (const name of ['summon-send', 'summon-receive', 'summon-telegram', 'summon-who'])
		expect(context).toContain(join(name, 'SKILL.md'));
	expect(context).not.toContain('Missing bundled skill');
	expect(context).not.toContain('summon-next');
	expect(context).toContain('summon --status needs-user');
});

test('startup rest guidance preserves the operator decision and child-process boundaries', () => {
	expect(CHECKPOINT_STARTUP_INSTRUCTION).toContain('Room line for the operator');
	expect(CHECKPOINT_STARTUP_INSTRUCTION).toContain(
		'Readiness and status grant no work authority',
	);
	expect(CHECKPOINT_STARTUP_INSTRUCTION).toContain(
		'Never rest while your own child process is running',
	);
	expect(CHECKPOINT_STARTUP_INSTRUCTION).not.toContain('Phillip');
});
