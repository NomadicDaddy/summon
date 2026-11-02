import { dispatchSchedules } from '../../src/schedules.ts';

await dispatchSchedules(
	() => Promise.resolve(true),
	() => Promise.resolve(),
	Number(process.argv[2]),
);
