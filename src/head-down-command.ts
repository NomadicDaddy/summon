import { delegateHeadDown } from './head-down-access.ts';
import { readHeadDown } from './head-down-model.ts';
import { decideHeadDown, endHeadDown, requestHeadDown } from './head-down.ts';
import { currentAgent } from './mail-identity.ts';

export async function headDownCommand(args: string[]): Promise<void> {
	const [action, name, id, value] = args;
	if (action === 'request' && name && id && value === '--return-to-normal' && args.length === 4) {
		console.log(JSON.stringify(await requestHeadDown(name, id, true)));
		return;
	}
	if (action === 'status' && args.length === 1) {
		console.log(JSON.stringify((await readHeadDown(currentAgent())) ?? null));
		return;
	}
	if (action === 'delegate' && name && ['on', 'off'].includes(id ?? '') && args.length === 3) {
		await delegateHeadDown(name, id === 'on');
		return;
	}
	if (name && id && ['approve', 'decline'].includes(action ?? '') && args.length === 3) {
		await decideHeadDown(name, id, action === 'approve');
		return;
	}
	if (name && id && value && ['end', 'steer'].includes(action ?? '') && args.length === 4) {
		await endHeadDown(name, id, value, action === 'steer');
		return;
	}
	throw new Error(
		'Usage: --head-down request <goal> <completion> --return-to-normal | status | approve|decline <name> <id> | end|steer <name> <id> <reason> | delegate <name> on|off',
	);
}
