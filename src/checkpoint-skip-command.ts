import { applyCatchUp } from './checkpoint-skip-apply.ts';
import { prepareCatchUp } from './checkpoint-skip-capture.ts';
import { skipProgress } from './checkpoint-skip-progress.ts';
import { loadSkipPlan, skipBody, skipView } from './checkpoint-skip-store.ts';
import { isHibernated } from './hibernation.ts';
import { localAgent } from './local-room-access.ts';

export async function catchUpCommand(args: string[]): Promise<Record<string, unknown>> {
	const name = await localAgent();
	if (await isHibernated(name)) throw new Error('Hibernation takes precedence over catch-up.');
	if (!args.length) return prepareCatchUp(name, 1);
	if (args[0] === '--keep-pages' && args.length === 2 && /^[1-3]$/.test(args[1] ?? ''))
		return prepareCatchUp(name, Number(args[1]));
	if (args[0] === 'status' && args.length === 1)
		return { catchUp: (await skipProgress(name)) ?? null };
	const id = args[1];
	if (args[0] === 'apply' && id && args.length === 2) return applyCatchUp(name, id);
	if (args[0] === 'list' && id && (args.length === 2 || args.length === 3)) {
		if (args[2] !== undefined && !/^\d+$/.test(args[2]))
			throw new Error('Invalid index offset.');
		return skipView(name, await loadSkipPlan(name, id), Number(args[2] ?? '0'));
	}
	if (args[0] === 'show' && id && (args.length === 4 || args.length === 5)) {
		if (args[4] !== undefined && !/^\d+$/.test(args[4]))
			throw new Error('Invalid body offset.');
		return skipBody(
			await loadSkipPlan(name, id),
			args[2] ?? '',
			args[3] ?? '',
			Number(args[4] ?? '0'),
		);
	}
	throw new Error(
		'Usage: summon --checkpoint catch-up [--keep-pages 1..3] | apply <plan-id> | list <plan-id> [offset] | show <plan-id> room|telegram <id> [byte-offset] | status',
	);
}
