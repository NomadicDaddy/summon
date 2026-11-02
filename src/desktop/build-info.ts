import { element } from './required-element.ts';

/**
 * "2026-10-14 08:31:05 CDT": a build time on the viewing machine's clock. build.json and the page
 * carry the UTC instant, so the builder's time zone never ends up in the artifact.
 */
export function localBuildTime(instant: Date, timeZone?: string): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
		timeZoneName: 'short',
		...(timeZone ? { timeZone } : {}),
	}).formatToParts(instant);
	const part = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((entry) => entry.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')} ${part('timeZoneName')}`;
}

/**
 * The footer's repository link. The build step writes the time in UTC inside a <time> element; it
 * is shown here in local time, with the UTC original kept in the tooltip.
 */
export function setupBuildInfo(showError: (error: unknown) => void): void {
	const link = element('build-info');
	const stamp = link.querySelector('time');
	const instant = stamp ? new Date(stamp.dateTime) : null;
	if (stamp && instant && !Number.isNaN(instant.getTime())) {
		stamp.title = stamp.textContent;
		stamp.textContent = localBuildTime(instant);
	}
	link.addEventListener('click', (event) => {
		event.preventDefault();
		void window.team.openRepository().catch(showError);
	});
}
