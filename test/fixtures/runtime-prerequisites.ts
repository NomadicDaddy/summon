import type {
	RuntimePrerequisite,
	RuntimePrerequisiteStatus,
} from '../../src/runtime-prerequisites.ts';

import { runtimePrerequisites } from '../../src/runtime-prerequisites.ts';

export const runtimeRequirements: RuntimePrerequisite[] = runtimePrerequisites;

export const runtimeResults = (
	status: RuntimePrerequisiteStatus['status'],
): RuntimePrerequisiteStatus[] =>
	runtimeRequirements.map(({ id }) => ({ id, status, detail: `${id}: fixture ${status}` }));
