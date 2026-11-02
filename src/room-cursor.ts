import { join } from 'node:path';

import { runtimePath } from './mail-session.ts';

export function roomCursor(value: string): number {
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
		throw new Error('Expected a nonnegative integer.');
	return Number(value);
}

export const localCursorPath = (name: string): string => join(runtimePath(name), 'room.cursor');
