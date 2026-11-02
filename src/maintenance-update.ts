import { z } from 'zod';

const commit = z.string().regex(/^[a-f0-9]{40}$/);
export const installedBuildSchema = z
	.object({
		commit,
		version: z.string().min(1),
		buildId: z.string().regex(/^[a-f0-9]{10}$/),
	})
	.strict();
export type InstalledBuild = z.infer<typeof installedBuildSchema>;
export const maintenanceStateSchema = z
	.object({
		version: z.literal(1),
		current: installedBuildSchema,
		previous: installedBuildSchema.optional(),
		pending: z
			.object({ target: commit, direction: z.enum(['update', 'rollback']) })
			.strict()
			.optional(),
	})
	.strict();
export type MaintenanceState = z.infer<typeof maintenanceStateSchema>;

/** The real host and disposable integration fixtures use the same ordered transaction. */
export interface MaintenanceHost {
	readState: () => Promise<MaintenanceState | undefined>;
	writeState: (state: MaintenanceState) => Promise<void>;
	installed: () => Promise<InstalledBuild>;
	main: () => Promise<string>;
	preflight: () => Promise<void>;
	compatible: (pin: string) => Promise<void>;
	offline: () => Promise<void>;
	checkout: (pin: string, rollback: boolean) => Promise<void>;
	assertCheckout: (pin: string, main: string, rollback: boolean) => Promise<void>;
	install: () => Promise<void>;
	build: () => Promise<void>;
	gate: () => Promise<void>;
}

/** Retain the previous installed build BEFORE any checkout/dependency/output mutation. */
export async function maintainInstallation(
	host: MaintenanceHost,
	rollback: boolean,
): Promise<MaintenanceState> {
	await host.preflight();
	await host.offline();
	const saved = await host.readState();
	const state = saved ?? { version: 1 as const, current: await host.installed() };
	if (state.pending && !rollback)
		throw new Error(
			'Previous update is incomplete. Retain logs and run --rollback before updating.',
		);
	if (!state.pending && saved) {
		const installed = await host.installed();
		if (JSON.stringify(installed) !== JSON.stringify(state.current))
			throw new Error(
				'Installed build differs from the recorded installation; preserve state.',
			);
	}
	const main = commit.parse(await host.main());
	const previous =
		state.pending?.direction === 'rollback'
			? [state.current, state.previous].find(
					(build) => build?.commit === state.pending?.target,
				)
			: state.pending
				? state.current
				: state.previous;
	if (rollback && !previous) throw new Error('No previous installed build is recorded.');
	const target = rollback && previous ? previous.commit : main;
	await host.compatible(target);
	await host.writeState({
		...state,
		pending: { target, direction: rollback ? 'rollback' : 'update' },
	});
	await host.offline();
	await host.checkout(target, rollback);
	await host.assertCheckout(target, main, rollback);
	await host.install();
	await host.assertCheckout(target, main, rollback);
	await host.build();
	const beforeGate = await host.installed();
	if (beforeGate.commit !== target)
		throw new Error('Build revision differs from selected commit.');
	if (rollback && previous && JSON.stringify(beforeGate) !== JSON.stringify(previous))
		throw new Error('Rollback build differs from the recorded previous build; remain offline.');
	await host.gate();
	await host.assertCheckout(target, main, rollback);
	await host.offline();
	const afterGate = await host.installed();
	if (JSON.stringify(afterGate) !== JSON.stringify(beforeGate))
		throw new Error('Build identity changed during the full gate; remain offline.');
	const result: MaintenanceState = {
		version: 1,
		current: afterGate,
		// Repeating an update at the same build must not erase the useful rollback target.
		...(state.current.commit === afterGate.commit
			? state.previous
				? { previous: state.previous }
				: {}
			: { previous: state.current }),
	};
	await host.writeState(result);
	return result;
}
