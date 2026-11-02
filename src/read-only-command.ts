import { compactionCommand } from './compaction-command.ts';
import { currentRequestCommand } from './current-request-command.ts';
import { readLaunchStatus } from './launch-status.ts';
import { localAgent } from './local-room-access.ts';
import { mailRetentionCommand } from './mail-retention-command.ts';
import { presenceCommand } from './presence-command.ts';
import { roomLookup } from './room-lookup.ts';
import { runtimeFaultCommand } from './runtime-fault-command.ts';
import { scheduleCommand } from './schedule-command.ts';
import { sessionHistoryCommand } from './session-history.ts';
import { workView } from './work-view.ts';

/** Route these views before store initialization so they cannot rewrite startup instructions. */
export async function readOnlyCommand(args: string[]): Promise<boolean> {
	if (args[0] === '--current-requests') await currentRequestCommand(args.slice(1));
	else if (args[0] === '--mail-retention') await mailRetentionCommand(args.slice(1));
	else if (args[0] === '--compactions') await compactionCommand(args.slice(1));
	else if (args[0] === '--faults') await runtimeFaultCommand(args.slice(1));
	else if (args[0] === '--presence') await presenceCommand(args.slice(1));
	else if (args[0] === '--session-history') await sessionHistoryCommand(args.slice(1));
	else if (args[0] === '--launch-status') {
		if (args.length !== 1) throw new Error('Usage: summon --launch-status');
		console.log(JSON.stringify(await readLaunchStatus()));
	} else if (args[0] === '--work') {
		if (args.length !== 1) throw new Error('Usage: summon --work (your named session only)');
		console.log(JSON.stringify(await workView()));
	} else if (args[0] === '--room' && (args[1] === 'show' || args[1] === 'search')) {
		await localAgent();
		console.log(JSON.stringify(await roomLookup(args.slice(1))));
	} else if (args[0] === '--schedule' && args[1] === 'summary')
		await scheduleCommand(args.slice(1));
	else return false;
	return true;
}
