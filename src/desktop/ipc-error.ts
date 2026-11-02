/**
 * Say what went wrong without saying how the message travelled.
 *
 * Electron rejects a failed `invoke` with the handler's message wrapped in its own: a duplicate
 * teammate name reached the operator as
 *
 *   Error invoking remote method 'team:save-profile': Error: That teammate already exists.
 *
 * where the only part addressed to a person is the last sentence. Found while verifying the new-user
 * flow end to end - the backend's own wording was fine, and everything in front of it was plumbing.
 *
 * This affects every failure in the maintenance dialog, not only the duplicate that exposed it.
 */
const WRAPPER = /^Error invoking remote method '[^']*':\s*/;
const CLASS_PREFIX = /^(?:[A-Za-z]*Error):\s*/;

export function readableError(cause: unknown): string {
	const message = cause instanceof Error ? cause.message : String(cause);
	return message.replace(WRAPPER, '').replace(CLASS_PREFIX, '').trim();
}
