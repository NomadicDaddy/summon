/** Capture the host's local clock and zone together, including the date-specific DST offset. */
export function startupTime(now = new Date()): string {
	const formatter = new Intl.DateTimeFormat('en-GB', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
		timeZoneName: 'longOffset',
	});
	const parts = formatter.formatToParts(now);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((entry) => entry.type === type)?.value ?? '';
	const offset = part('timeZoneName').replace('GMT', 'UTC');
	return [
		`Local time at session startup: ${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')} ${offset === 'UTC' ? 'UTC+00:00' : offset}.`,
		`Machine time zone: ${formatter.resolvedOptions().timeZone}.`,
		'Use this machine-local time zone for dates and times shown to the user unless they request another zone.',
		'Timestamps ending in Z are UTC; convert them before describing them as local time.',
		'This is a startup snapshot, not a live clock. Check the current local time when timing matters.',
	].join('\n');
}
