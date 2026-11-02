import type { ResponseObservation } from './response-watchdog-model.ts';
import type { ResponseState } from './response-watchdog-store.ts';
import type { WakeTarget } from './wake-part.ts';

import { automaticNoticeSuppressed } from './automatic-notice.ts';
import { checkpointHash } from './checkpoint-package-model.ts';
import { responseInventory } from './response-watchdog-inventory.ts';
import { responsePackageProgress } from './response-watchdog-progress.ts';
import { relayResponseWatchdog } from './response-watchdog-relay.ts';
import { responseTargetRetired } from './response-watchdog-retired.ts';
import { updateResponseState } from './response-watchdog-store.ts';
import { wakeTargetRead } from './wake-read-proof.ts';

/** Evaluates read progress and relays episode changes to the PM; never retries provider input. */
export async function evaluateResponseWatchdog(name: string, nonce: string): Promise<void> {
	await updateResponseState(name, nonce, async (previous) => {
		const suspended = await automaticNoticeSuppressed(name);
		if (suspended)
			return {
				observations: previous?.episode.expectations ?? [],
				targets: previous?.targets ?? {},
				suspended,
			};
		let inventory;
		try {
			inventory = await responseInventory(name, nonce);
		} catch {
			inventory = { targets: [], failures: ['inventory'] };
		}
		let packageProgress: Awaited<ReturnType<typeof responsePackageProgress>> = () => undefined;
		try {
			packageProgress = await responsePackageProgress(name);
		} catch {
			inventory.failures.push('checkpoint');
		}
		const targets: Record<string, WakeTarget> = {};
		const proofs: ResponseState['proofs'] = {};
		const observations: ResponseObservation[] = [];
		const old = new Map(previous?.episode.expectations.map((item) => [item.id, item]));
		// Missing observations are not proof. Only exact reads or explicit archival retire work.
		const candidates = { ...previous?.targets };
		const current = new Set<string>();
		for (const target of inventory.targets) {
			const id = checkpointHash(target);
			current.add(id);
			candidates[id] = target;
		}
		for (const [id, target] of Object.entries(candidates)) {
			try {
				if (await wakeTargetRead(name, nonce, target)) continue;
				if (!current.has(id) && (await responseTargetRetired(name, target))) continue;
			} catch {
				inventory.failures.push(target.source);
			}
			targets[id] = target;
			const proof = packageProgress(target);
			const priorProof = previous?.proofs[id];
			if (proof) proofs[id] = proof;
			const advanced =
				proof &&
				proof.page > (priorProof?.packageId === proof.packageId ? priorProof.page : 0);
			observations.push({
				id,
				condition: old.get(id)?.condition ?? 'blocked',
				progress: (old.get(id)?.progress ?? 0) + (advanced ? 1 : 0),
			});
		}
		for (const source of new Set(inventory.failures))
			observations.push({
				id: `inventory:${source}`,
				condition: 'inventory',
				progress: 0,
			});
		return { targets, observations, proofs, suspended: await automaticNoticeSuppressed(name) };
	});
	await relayResponseWatchdog(name, nonce);
}

export async function recordResponseAttempt(
	name: string,
	nonce: string,
	targets: WakeTarget[],
	condition: 'uncertain' | 'awaiting-read' | 'blocked',
	outcome: string,
): Promise<void> {
	await updateResponseState(name, nonce, async (previous) => {
		const retained = { ...previous?.targets };
		const outcomes = { ...previous?.outcomes };
		const observations = new Map(previous?.episode.expectations.map((item) => [item.id, item]));
		for (const target of targets) {
			// A delivered room bound includes earlier eligible bounds of this same conversation.
			if (target.source === 'room' || target.source === 'telegram') {
				for (const [key, value] of Object.entries(retained)) {
					if (
						value.source !== target.source ||
						value.key !== target.key ||
						value.through > target.through
					)
						continue;
					const old = observations.get(key);
					if (old) observations.set(key, { ...old, condition });
					outcomes[key] = outcome;
				}
			}
			const units = target.ids.length
				? target.ids.map((id) => ({ ...target, ids: [id] }))
				: [target];
			for (const unit of units) {
				const id = checkpointHash(unit);
				retained[id] = unit;
				outcomes[id] = outcome;
				const old = observations.get(id);
				observations.set(id, {
					id,
					condition,
					progress: old?.progress ?? 0,
					startedAt: old?.startedAt ?? Date.now(),
					progressAt: old?.progressAt ?? Date.now(),
				});
			}
		}
		return {
			targets: retained,
			outcomes,
			observations: [...observations.values()],
			suspended: await automaticNoticeSuppressed(name),
		};
	});
}
