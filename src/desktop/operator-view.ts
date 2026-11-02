import type { BrowserWindow } from 'electron';

import { saveOperatorView } from '../operator-view.ts';
import {
	DEFAULT_HOLD_POLICY,
	type HoldPolicy,
	notificationPause,
	type NotificationPauseView,
} from './notification-pause.ts';

/** Publish only operator focus, never terminal output or provider activity. */
export function trackOperatorView(
	window: BrowserWindow,
	selected: () => string,
	running: (name: string) => boolean,
	error: (error: unknown) => void,
	policy: () => HoldPolicy = () => DEFAULT_HOLD_POLICY,
): {
	refresh: () => void;
	terminalInput: (name: string, humanInput: boolean) => void;
	set: (paused: boolean) => Promise<void>;
	view: () => NotificationPauseView;
} {
	const pause = notificationPause(Date.now, policy);
	let pending = Promise.resolve();
	const view = (): NotificationPauseView => {
		const name = selected();
		pause.select(name, running(name));
		return pause.view();
	};
	const refresh = (): void => {
		pending = pending
			.then(() => {
				const state = view();
				return saveOperatorView(
					state.paused &&
						!window.isDestroyed() &&
						(state.manual || (window.isFocused() && !window.isMinimized()))
						? selected()
						: '',
					Date.now(),
					state.until,
				);
			})
			.catch(error);
	};
	const timer = setInterval(refresh, 2000);
	window.on('focus', refresh);
	window.on('blur', refresh);
	window.on('minimize', refresh);
	window.on('restore', refresh);
	window.on('closed', () => {
		clearInterval(timer);
		refresh();
	});
	refresh();
	return {
		refresh,
		view,
		terminalInput: (name, humanInput) => {
			// A terminal's own replies cannot renew the hold, so they need no re-read or write:
			// mouse-motion tracking would otherwise queue a saveOperatorView write per report.
			if (!humanInput) return;
			view();
			pause.terminalInput(name, humanInput);
			refresh();
		},
		set: async (paused) => {
			view();
			pause.set(paused);
			refresh();
			await pending;
		},
	};
}
