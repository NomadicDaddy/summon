/** Do not resume a window while another owned process is still being stopped. */
export async function settleStops(stops: Promise<void>[]): Promise<void> {
	const results = await Promise.allSettled(stops);
	const errors = results.flatMap((result) =>
		result.status === 'rejected' ? [result.reason as unknown] : [],
	);
	if (errors.length)
		throw new AggregateError(errors, 'Could not stop every session; inspect and retry.');
}

interface ShutdownDependencies {
	stopPolling: () => Promise<void>;
	startPolling: () => void;
	setClosing: (closing: boolean) => void;
	stopSessions: () => Promise<void>[];
	recover: () => void;
	quit: () => void;
	error: (error: unknown) => void;
}

export function createWindowShutdown(deps: ShutdownDependencies): {
	request: () => Promise<void>;
	close: (event: { preventDefault: () => void }) => void;
} {
	let pending: Promise<void> | undefined;
	let complete = false;
	const request = (): Promise<void> => {
		if (pending) return pending;
		if (complete) return Promise.resolve();
		deps.setClosing(true);
		pending = Promise.resolve()
			.then(async () => {
				await deps.stopPolling();
				await settleStops(deps.stopSessions());
				complete = true;
				deps.quit();
			})
			.catch((error: unknown) => {
				complete = false;
				deps.setClosing(false);
				deps.recover();
				deps.startPolling();
				deps.error(error);
			})
			.finally(() => {
				pending = undefined;
			});
		return pending;
	};
	return {
		request,
		close: (event) => {
			if (complete) return;
			event.preventDefault();
			void request();
		},
	};
}
