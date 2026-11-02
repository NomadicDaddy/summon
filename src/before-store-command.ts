import { operatorIdentityRouted } from './operator-identity.ts';
import { readOnlyCommand } from './read-only-command.ts';
import { roomWakePolicyRouted } from './room-wake-policy.ts';

/** These commands must not initialize the store or rewrite generated startup instructions. */
export async function beforeStoreCommand(args: string[]): Promise<boolean> {
	return (
		(await roomWakePolicyRouted(args)) ||
		(await operatorIdentityRouted(args)) ||
		(await readOnlyCommand(args))
	);
}
