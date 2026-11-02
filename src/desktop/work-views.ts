import { setupRepos } from './repos-panel.ts';
import { setupScheduleView } from './schedule-view-panel.ts';

/**
 * The work views that read without changing anything. Schedules is set up after Repos on purpose:
 * each view closes when another's sidebar button reports pressed, so its listener has to run after
 * the other view's own.
 */
export function setupReadOnlyWorkViews(
	showError: (error: unknown) => void,
	selectMember: (slug: string) => Promise<boolean>,
): void {
	setupRepos(showError, selectMember);
	setupScheduleView();
}
