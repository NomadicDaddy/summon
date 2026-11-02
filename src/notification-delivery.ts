/** Raised only when no provider input has been written or provider process started. */
export class NotificationNotSentError extends Error {}

/** Automatic submission stopped after paste; preserve the input until human inspection. */
export class NotificationUnsubmittedError extends Error {
	constructor(cause: unknown) {
		const reason = cause instanceof Error ? cause.message : 'Terminal input failed.';
		super(
			`Claude notice could not finish submission; inspect its input before retrying: ${reason}`,
			{ cause },
		);
	}
}

/** After the paste and before writing its Enter, Summon refused to submit; no Enter was written. */
export class NotificationEnterWithheldError extends NotificationUnsubmittedError {
	/** The pane-input version Summon marked for its own paste; human input moves it on. */
	readonly pasteVersion: number;
	constructor(cause: unknown, pasteVersion: number) {
		super(cause);
		this.pasteVersion = pasteVersion;
	}
}

/** This check runs before the caller performs any provider input. */
export async function assertNotificationOpen(): Promise<void> {
	try {
		await assertCommunicationsOpen();
	} catch (error: unknown) {
		throw new NotificationNotSentError(
			error instanceof Error ? error.message : 'Notifications are unavailable.',
			{ cause: error },
		);
	}
}
import { assertCommunicationsOpen } from './communication-state.ts';
