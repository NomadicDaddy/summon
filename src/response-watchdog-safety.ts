import { recoverResponseFailure, retainResponseFailure } from './response-watchdog-errors.ts';

/** Diagnostic persistence must never reclassify a provider write or authorize another one. */
export async function trackResponseSafely(
	name: string,
	action: () => Promise<void>,
	recover = false,
) {
	try {
		await action();
		if (recover) await recoverResponseFailure(name);
	} catch {
		try {
			if (await retainResponseFailure(name))
				console.error(`${name}: response watchdog unavailable; inspect delivery details.`);
		} catch {
			console.error(`${name}: response watchdog and diagnostic storage unavailable.`);
		}
	}
}
