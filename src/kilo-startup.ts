import { randomUUID } from 'node:crypto';

import { captureKiloModel } from './kilo-model-observation.ts';
import { kiloStartupSettled, kiloStartupSubmitting } from './kilo-turn-state.ts';
import { startKiloTurnStream } from './kilo-turn-stream.ts';
import { storedKiloVariant, supportedKiloVariant } from './kilo-variant.ts';
import { observeLaunch, providerUp } from './launch-phase.ts';

const prompt =
	'Follow your current Summon instructions. Run summon --checkpoint, read each delivered batch before passing its receipt, and respond to pending user requests within your authority.';

/** A separate authenticated worker prevents delivery to another Kilo session or shared daemon. */
export async function kiloStartup(
	cwd: string,
	sessionId: string,
	model?: string,
	launch?: { name: string; nonce: string },
	registeredVariant?: string,
	catalogWaitMs?: number,
) {
	const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
	const port = reservation.port;
	await reservation.stop(true);
	const password = randomUUID();
	const headers = {
		Authorization: `Basic ${Buffer.from(`kilo:${password}`).toString('base64')}`,
		'Content-Type': 'application/json',
	};
	const url = `http://127.0.0.1:${port}/session/${encodeURIComponent(sessionId)}`;
	const query = `?directory=${encodeURIComponent(cwd)}`;
	return {
		args: ['--hostname', '127.0.0.1', '--port', String(port)],
		env: {
			KILO_NO_DAEMON: '1',
			KILO_SERVER_USERNAME: 'kilo',
			KILO_SERVER_PASSWORD: password,
		},
		start: async (signal: AbortSignal): Promise<void> => {
			const readySignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
			let ready = false;
			let stored: string | undefined;
			while (!ready) {
				readySignal.throwIfAborted();
				try {
					const response = await fetch(`${url}${query}`, {
						headers,
						redirect: 'error',
						signal: AbortSignal.any([readySignal, AbortSignal.timeout(1000)]),
					});
					// The server is bound to an ephemeral credential, and the exact session must exist.
					ready = response.ok;
					if (ready)
						stored = storedKiloVariant(
							await response.json().catch(() => undefined),
							sessionId,
						);
					else await response.body?.cancel();
				} catch {
					readySignal.throwIfAborted();
				}
				if (!ready) await Bun.sleep(250);
			}
			signal.throwIfAborted();
			if (launch) {
				let capturing = false;
				let requested = false;
				const modelChanged = (): void => {
					requested = true;
					if (capturing) return;
					capturing = true;
					void (async () => {
						try {
							while (requested && !signal.aborted) {
								requested = false;
								await captureKiloModel(
									`http://127.0.0.1:${port}`,
									query,
									headers,
									signal,
									launch,
									sessionId,
								).catch(() => {});
							}
						} finally {
							capturing = false;
						}
					})();
				};
				// Subscribe before startup input so its real busy/idle pair cannot be missed.
				const unavailable = (): void => {
					if (!signal.aborted)
						console.error(
							'Kilo completion unavailable; ordinary notices remain queued.',
						);
				};
				try {
					const { completion } = await startKiloTurnStream(
						`http://127.0.0.1:${port}/event${query}`,
						headers,
						signal,
						launch,
						sessionId,
						modelChanged,
					);
					void completion.catch(unavailable);
					modelChanged();
				} catch {
					unavailable();
					signal.throwIfAborted();
				}
			}
			if (launch)
				await observeLaunch(
					providerUp(launch.name, launch.nonce, 'kilo', 'kilo-owned-session'),
				);
			const slash = model?.indexOf('/') ?? -1;
			const selected =
				model && slash > 0
					? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
					: undefined;
			// Without a model Kilo keeps the stored variant itself; with one it can save "default".
			// The registered variant is the seat's setting (Phillip #20221 A); the session's stored
			// one, which the agent config rewrites on every turn, counts only when none is registered.
			const choice = registeredVariant ?? stored;
			const variant =
				selected && choice
					? await supportedKiloVariant(
							`http://127.0.0.1:${port}`,
							query,
							headers,
							signal,
							selected,
							choice,
							catalogWaitMs,
						)
					: undefined;
			// Marked before the POST, so a turn that goes busy and idle before the response still
			// counts; the outcome is recorded after it. Notices wait for both (Phillip #22057).
			if (launch) await kiloStartupSubmitting(launch.name, launch.nonce, sessionId);
			const settle = async (outcome: 'accepted' | 'uncertain'): Promise<void> => {
				if (launch) await kiloStartupSettled(launch.name, launch.nonce, sessionId, outcome);
			};
			// Never retry a POST: timeout or disconnect can occur after Kilo accepted the turn.
			let response: Response;
			try {
				response = await fetch(`${url}/prompt_async${query}`, {
					method: 'POST',
					headers,
					redirect: 'error',
					signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
					body: JSON.stringify({
						...(selected ? { model: selected } : {}),
						...(variant ? { variant } : {}),
						parts: [{ type: 'text', text: prompt }],
					}),
				});
			} catch (error: unknown) {
				await settle('uncertain');
				throw error;
			}
			await response.body?.cancel();
			// A non-2xx response can't prove Kilo took no turn, so it is uncertain, not refused.
			await settle(response.ok ? 'accepted' : 'uncertain');
			if (!response.ok) throw new Error('Kilo did not acknowledge its startup turn.');
		},
	};
}
