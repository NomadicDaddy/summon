import { sessionHeartbeat } from './head-down-model.ts';
import { finishHeadDownLaunch } from './head-down.ts';

export async function startSessionHeartbeat(
	name: string,
	nonce: string,
): Promise<() => Promise<void>> {
	await finishHeadDownLaunch(name);
	await sessionHeartbeat(name, nonce);
	let pending = Promise.resolve();
	const timer = setInterval(() => {
		pending = pending
			.then(() => sessionHeartbeat(name, nonce))
			.catch((error: unknown) => {
				console.error(
					'Session heartbeat failed:',
					error instanceof Error ? error.message : String(error),
				);
			});
	}, 5000);
	return async () => {
		clearInterval(timer);
		await pending;
		await finishHeadDownLaunch(name, nonce);
	};
}
