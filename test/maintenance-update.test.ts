import { expect, test } from 'bun:test';

import type {
	InstalledBuild,
	MaintenanceHost,
	MaintenanceState,
} from '../src/maintenance-update.ts';

import { verifyOfflineSnapshot } from '../src/maintenance-offline.ts';
import { maintainInstallation } from '../src/maintenance-update.ts';

const old: InstalledBuild = { commit: 'a'.repeat(40), version: '1.0.0', buildId: 'a'.repeat(10) };
const next: InstalledBuild = { commit: 'b'.repeat(40), version: '1.0.1', buildId: 'b'.repeat(10) };

async function rejects(operation: Promise<unknown>, message: string): Promise<void> {
	let failure: unknown;
	try {
		await operation;
	} catch (error: unknown) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(Error);
	expect(failure instanceof Error ? failure.message : '').toContain(message);
}

function fixture(initial?: MaintenanceState) {
	let state = initial;
	let installed = { ...old };
	let chosen = old.commit;
	const calls: string[] = [];
	const host: MaintenanceHost = {
		readState: () => Promise.resolve(state),
		writeState: (value) => {
			state = structuredClone(value);
			calls.push(value.pending ? 'journal' : 'complete');
			return Promise.resolve();
		},
		installed: () => Promise.resolve(installed),
		main: () => Promise.resolve(next.commit),
		preflight: () => {
			calls.push('preflight');
			return Promise.resolve();
		},
		compatible: () => {
			calls.push('compatible');
			return Promise.resolve();
		},
		offline: () => {
			calls.push('offline');
			return Promise.resolve();
		},
		checkout: (pin) => {
			chosen = pin;
			calls.push('checkout');
			return Promise.resolve();
		},
		assertCheckout: () => {
			calls.push('identity');
			return Promise.resolve();
		},
		install: () => {
			calls.push('install');
			return Promise.resolve();
		},
		build: () => {
			installed = chosen === old.commit ? { ...old } : { ...next };
			calls.push('build');
			return Promise.resolve();
		},
		gate: () => {
			calls.push('gate');
			return Promise.resolve();
		},
	};
	return {
		host,
		calls,
		state: () => state,
		changeBuild: (value: InstalledBuild) => {
			installed = value;
		},
	};
}

test('update journals the installed build before mutation and completes only after exact gate identity', async () => {
	const f = fixture();
	expect(await maintainInstallation(f.host, false)).toEqual({
		version: 1,
		current: next,
		previous: old,
	});
	expect(f.calls).toEqual([
		'preflight',
		'offline',
		'compatible',
		'journal',
		'offline',
		'checkout',
		'identity',
		'install',
		'identity',
		'build',
		'gate',
		'identity',
		'offline',
		'complete',
	]);
});

test('failed full gate preserves previous build and permits rollback without a successful new install', async () => {
	const f = fixture();
	f.host.gate = () => Promise.reject(new Error('QC failed'));
	await rejects(maintainInstallation(f.host, false), 'QC failed');
	expect(f.state()).toEqual({
		version: 1,
		current: old,
		pending: { target: next.commit, direction: 'update' },
	});
	await rejects(maintainInstallation(f.host, false), 'incomplete');
	f.host.gate = () => Promise.resolve();
	const restored = await maintainInstallation(f.host, true);
	expect(restored.current).toEqual(old);
	expect(restored.pending).toBeUndefined();
});

test('rollback refuses a rebuilt fingerprint different from the recorded previous build', async () => {
	const f = fixture({ version: 1, current: next, previous: old });
	f.changeBuild(next);
	f.host.build = () => {
		f.changeBuild({ ...old, buildId: 'c'.repeat(10) });
		return Promise.resolve();
	};
	await rejects(maintainInstallation(f.host, true), 'Rollback build differs');
});

test('repeated rollback failures keep the original target at every mutation boundary', async () => {
	for (const boundary of ['checkout', 'install', 'build', 'gate'] as const) {
		const f = fixture();
		await maintainInstallation(f.host, false);
		const targets: string[] = [];
		const checkout = f.host.checkout;
		f.host.checkout = (pin, rollback) => {
			targets.push(pin);
			return checkout(pin, rollback);
		};
		const original = f.host[boundary];
		f.host[boundary] = () => Promise.reject(new Error(`failed ${boundary}`));
		for (let attempt = 0; attempt < 2; attempt++) {
			await rejects(maintainInstallation(f.host, true), `failed ${boundary}`);
			expect(f.state()).toEqual({
				version: 1,
				current: next,
				previous: old,
				pending: { target: old.commit, direction: 'rollback' },
			});
		}
		if (boundary === 'checkout') f.host.checkout = original;
		else f.host[boundary] = original as MaintenanceHost['install'];
		expect((await maintainInstallation(f.host, true)).current).toEqual(old);
		expect(f.state()?.pending).toBeUndefined();
		expect(targets.every((pin) => pin === old.commit)).toBe(true);
	}
});

test('interrupted recovery of a failed first update still restores the initial build', async () => {
	const f = fixture();
	f.host.gate = () => Promise.reject(new Error('gate failed'));
	await rejects(maintainInstallation(f.host, false), 'gate failed');
	await rejects(maintainInstallation(f.host, true), 'gate failed');
	await rejects(maintainInstallation(f.host, true), 'gate failed');
	expect(f.state()?.pending).toEqual({ target: old.commit, direction: 'rollback' });
	f.host.gate = () => Promise.resolve();
	expect((await maintainInstallation(f.host, true)).current).toEqual(old);
});

test('a changed build during QC is never recorded as installed', async () => {
	const f = fixture();
	f.host.gate = () => {
		f.changeBuild({ ...next, buildId: 'd'.repeat(10) });
		return Promise.resolve();
	};
	await rejects(maintainInstallation(f.host, false), 'identity changed');
});

test('offline and dirty-boundary refusals happen before journaling or checkout', async () => {
	for (const operation of ['offline', 'preflight', 'compatible'] as const) {
		const f = fixture();
		f.host[operation] = () => Promise.reject(new Error('refused'));
		await rejects(maintainInstallation(f.host, false), 'refused');
		expect(f.state()).toBeUndefined();
		expect(f.calls).not.toContain('checkout');
	}
});

test('offline snapshot needs its positive control and rejects active or uncertain owners', () => {
	expect(() => verifyOfflineSnapshot('{"control":false,"active":[]}')).toThrow();
	expect(() =>
		verifyOfflineSnapshot(
			'{"control":true,"active":[{"pid":12,"kind":"Named session runner"}]}',
		),
	).toThrow('not offline');
	expect(() => verifyOfflineSnapshot('{"control":true,"active":[]}')).not.toThrow();
});
