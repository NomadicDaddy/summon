import type { ErrorBanner } from './error-banner.ts';

/**
 * The window's action wrapper and the operator identity error, kept together because each one
 * decides what the other leaves on screen.
 *
 * Every action clears the banner first, so a failure it causes is the only thing showing. The
 * identity error is different: it describes a settings file that stays broken until someone fixes
 * it, and it is drawn only when its text changes. Before this, the first click of anything after a
 * fault cleared it for good, and the Room and Diary went on showing no operator names with nothing
 * on screen to say why. So a successful action draws the identity error again while it is still
 * current. A failed action keeps the box for its own error, Dismiss still hides the banner until
 * the next action, and `display` only draws, so the fault is journalled once per episode by the
 * snapshot that reported it.
 */
export interface WindowActions {
	action: (work: () => Promise<void>) => Promise<boolean>;
	/** Called with each snapshot's operatorError. */
	operatorError: (text: string | undefined) => void;
}

export function windowActions(
	banner: Pick<ErrorBanner, 'clear' | 'display' | 'show'>,
): WindowActions {
	let current = '';
	return {
		action: async (work) => {
			banner.clear();
			try {
				await work();
			} catch (error: unknown) {
				banner.show(error, 'window.action');
				return false;
			}
			if (current) banner.display(current);
			return true;
		},
		operatorError: (text) => {
			if (text && text !== current) banner.display(text);
			current = text ?? '';
		},
	};
}
