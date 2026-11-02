import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export async function storageLayoutHarness() {
	const saved = {
		SUMMON_HOME: process.env.SUMMON_HOME,
		SUMMON_TEAMS_HOME: process.env.SUMMON_TEAMS_HOME,
		SUMMON_AGENT: process.env.SUMMON_AGENT,
	};
	const root = await mkdtemp(join(tmpdir(), 'summon-layout-'));
	const base = join(root, 'teams with spaces');
	const selected = join(base, 'team-default');
	process.env.SUMMON_TEAMS_HOME = base;
	delete process.env.SUMMON_HOME;
	delete process.env.SUMMON_AGENT;
	return {
		root,
		base,
		selected,
		async dispose() {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) Reflect.deleteProperty(process.env, key);
				else process.env[key] = value;
			}
			if (
				dirname(resolve(root)) !== resolve(tmpdir()) ||
				!basename(root).startsWith('summon-layout-')
			)
				throw new Error('Unexpected layout fixture cleanup root');
			await rm(root, { recursive: true, force: true });
		},
	};
}
