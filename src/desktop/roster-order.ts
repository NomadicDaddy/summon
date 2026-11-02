import type { TeamAgent } from './types.ts';

/**
 * PM teammates first, so the PM heads the list as number 0 (Phillip, room #10250; Ctrl+0 selects it,
 * and Ctrl+1 the first teammate after it, #12557). Nothing else moves:
 * the PMs keep the order they had among themselves and so does everyone after them, which is the
 * order the roster already used. Returns a new array.
 */
export function pinManagers<T extends Pick<TeamAgent, 'memberType'>>(agents: readonly T[]): T[] {
	return [
		...agents.filter((agent) => agent.memberType === 'pm'),
		...agents.filter((agent) => agent.memberType !== 'pm'),
	];
}
