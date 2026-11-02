import { resolve } from 'node:path';

import type { RuntimeFaultInput } from '../runtime-fault-model.ts';
import type { TeamEvent } from './types.ts';

import { appendRuntimeFault } from '../runtime-faults.ts';
import { storageRoot } from '../store.ts';

/** Preserve display even when retention fails, without recursively logging that failure. */
export function runtimeFaultDelivery(
	windowStartedAt: () => string,
	send: (event: TeamEvent) => void,
	write: typeof appendRuntimeFault = appendRuntimeFault,
): {
	send: (event: TeamEvent) => void;
	report: (input: RuntimeFaultInput) => Promise<void>;
	flush: () => Promise<void>;
} {
	const root = resolve(storageRoot());
	let pending: Promise<void> = Promise.resolve();
	let failed = false;
	const report = (input: RuntimeFaultInput): Promise<void> => {
		const work = pending.then(async () => {
			await write(input, windowStartedAt(), root);
			failed = false;
		});
		pending = work.catch(() => {
			if (!failed)
				send({
					type: 'error',
					source: 'runtime-fault.persistence',
					message:
						'Runtime error log unavailable. Saving the diagnostic could not be confirmed.',
					diagnosticHandled: true,
				});
			failed = true;
		});
		return work;
	};
	return {
		report,
		flush: async () => {
			for (;;) {
				const observed = pending;
				await observed;
				if (observed === pending) return;
			}
		},
		send: (event) => {
			if (event.type !== 'error') {
				send(event);
				return;
			}
			void report({
				level: 'error',
				source: event.source ?? 'team.event',
				text: event.message.slice(0, 8192),
				...(event.slug === undefined ? {} : { member: event.slug }),
			}).then(
				() => send({ ...event, diagnosticHandled: true, diagnosticSaved: true }),
				() => send({ ...event, diagnosticHandled: true, diagnosticSaved: false }),
			);
		},
	};
}
