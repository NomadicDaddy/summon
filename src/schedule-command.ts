import { messageBodyArgs } from './message-body-file.ts';
import { summarizeSchedules } from './schedule-summary.ts';
import {
	createSchedule,
	enableSchedule,
	finishScheduledRun,
	listSchedules,
	updateSchedulePrompt,
} from './schedules.ts';

export async function scheduleCommand(args: string[]): Promise<void> {
	if (args[0] === 'update-prompt') args = await messageBodyArgs(args, 2);
	const [action, id, result] = args;
	if (action === 'list' && args.length === 1) console.log(JSON.stringify(await listSchedules()));
	else if (action === 'summary' && args.length === 1)
		console.log(
			JSON.stringify({ readOnly: true, ...summarizeSchedules(await listSchedules()) }),
		);
	else if (action === 'create' && id && args.length === 2)
		console.log(JSON.stringify(await createSchedule(JSON.parse(id) as unknown)));
	else if (action === 'run' && id && args.length === 2) {
		const run = (await listSchedules()).runs.find((run) => run.id === id);
		if (!run) throw new Error('Unknown scheduled run or not its owner.');
		console.log(JSON.stringify(run));
	} else if (action === 'update-prompt' && id && result && args.length === 3) {
		await updateSchedulePrompt(id, JSON.parse(result) as unknown);
		console.log('Schedule prompt updated. Existing runs are unchanged.');
	} else if ((action === 'pause' || action === 'resume') && id && args.length === 2) {
		await enableSchedule(id, action === 'resume');
		console.log('Schedule updated. Pending runs are not cancelled.');
	} else if ((action === 'complete' || action === 'fail') && id && result && args.length === 3) {
		await finishScheduledRun(id, action === 'complete' ? 'complete' : 'failed', result);
		console.log('Scheduled run resolved.');
	} else
		throw new Error(
			'Usage: summon --schedule list|summary | create <json> | update-prompt <id> <json>|--body-file <UTF-8-json-path> | run <id> | pause|resume <id> | complete|fail <run-id> <evidence>',
		);
}
