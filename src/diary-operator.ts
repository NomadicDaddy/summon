import type { OperatorIdentity } from './operator-identity-model.ts';

import { operatorNames } from './operator-identity-model.ts';

/** Recognition changes presentation only; the original stored recipient remains literal. */
export function forOperator(recipient: string, identity: OperatorIdentity | undefined): boolean {
	if (!identity) return false;
	const name = recipient.trim().toLowerCase();
	return operatorNames(identity).some((alias) => alias.toLowerCase() === name);
}
