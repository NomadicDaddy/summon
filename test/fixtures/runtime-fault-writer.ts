import { appendRuntimeFault } from '../../src/runtime-faults.ts';

const [root, label] = process.argv.slice(2);
if (!root || !label) throw new Error('Fixture needs its disposable root and label.');
process.env.SUMMON_HOME = root;
for (let index = 0; index < 5; index++)
	await appendRuntimeFault(
		{
			level: 'warning',
			source: 'fixture.concurrent',
			text: `Child ${label}, record ${index}.`,
		},
		'2026-10-06T20:00:00.000Z',
	);
