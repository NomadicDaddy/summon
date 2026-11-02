import { z } from 'zod';

export const scheduleDeferralReason = z.enum([
	'communications-paused',
	'hibernated',
	'owner-missing',
	'unfinished-run',
	'operator-viewing',
	'head-down',
	'window-closing',
	'not-running-here',
	'owner-busy',
	'owner-needs-user',
	'activity-unknown',
	'owner-unavailable',
]);
export type ScheduleAvailability = boolean | z.infer<typeof scheduleDeferralReason>;
export const scheduleDeferral = z.object({
	reason: scheduleDeferralReason,
	dueAt: z.number().int().nonnegative(),
	observedAt: z.number().int().nonnegative(),
});

/** Only changes the explanation; the original due date and run claims remain untouched. */
export function deferSchedule(
	item: { nextDueAt: number; deferred?: z.infer<typeof scheduleDeferral> | undefined },
	reason: z.infer<typeof scheduleDeferralReason>,
	now: number,
): boolean {
	if (item.deferred?.reason === reason && item.deferred.dueAt === item.nextDueAt) return false;
	item.deferred = { reason, dueAt: item.nextDueAt, observedAt: now };
	return true;
}
