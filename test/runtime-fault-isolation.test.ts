import { expect, test } from 'bun:test';
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { runtimeFaultDelivery } from '../src/desktop/runtime-fault-delivery.ts';
import { appendRuntimeFault, readRuntimeFaults } from '../src/runtime-faults.ts';
import {
	runtimeFaultFixture as fixture,
	runtimeFaultRejection as rejection,
} from './fixtures/runtime-fault-test.ts';

const started = '2026-10-07T04:00:00.000Z';

test('queued diagnostics keep their creating team root after the environment changes', async () =>
	fixture(async (root) => {
		const other = join(root, 'other-team');
		await mkdir(other);
		const delivery = runtimeFaultDelivery(
			() => started,
			() => {},
		);
		await delivery.report({ level: 'error', source: 'fixture.root', text: 'First positive' });
		expect((await readRuntimeFaults({ limit: 10 })).entries[0]?.text).toBe('First positive');
		process.env.SUMMON_HOME = other;
		await appendRuntimeFault(
			{ level: 'error', source: 'fixture.root', text: 'Other positive' },
			started,
		);
		const otherPath = join(other, 'logs/runtime-faults/current.jsonl');
		const retained = await readFile(otherPath, 'utf8');
		process.env.SUMMON_HOME = root;
		const queued = delivery.report({
			level: 'error',
			source: 'fixture.root',
			text: 'Queued for first',
		});
		process.env.SUMMON_HOME = other;
		await queued;
		await delivery.flush();
		expect(await readFile(otherPath, 'utf8')).toBe(retained);
		process.env.SUMMON_HOME = root;
		expect(
			(await readRuntimeFaults({ limit: 10 })).entries.some(
				(entry) => entry.text === 'Queued for first',
			),
		).toBe(true);
	}));

test('a fault transaction cannot change team roots across asynchronous checks', async () =>
	fixture(async (root) => {
		const other = join(root, 'other-team');
		await mkdir(other);
		const pending = appendRuntimeFault(
			{ level: 'error', source: 'fixture.root', text: 'Original transaction' },
			started,
		);
		process.env.SUMMON_HOME = other;
		await pending;
		expect((await readRuntimeFaults({ limit: 10 })).retainedOccurrences).toBe(0);
		process.env.SUMMON_HOME = root;
		expect((await readRuntimeFaults({ limit: 10 })).entries[0]?.text).toBe(
			'Original transaction',
		);
	}));

test('a removed originating root refuses retention without recreating or redirecting it', async () =>
	fixture(async (root) => {
		const originating = join(root, 'removed-team');
		await mkdir(originating);
		process.env.SUMMON_HOME = originating;
		let unavailable = 0;
		const delivery = runtimeFaultDelivery(
			() => started,
			() => {
				unavailable += 1;
			},
		);
		await delivery.report({ level: 'error', source: 'fixture.root', text: 'Origin positive' });
		expect((await readRuntimeFaults({ limit: 10 })).entries[0]?.text).toBe('Origin positive');
		process.env.SUMMON_HOME = root;
		await appendRuntimeFault(
			{ level: 'error', source: 'fixture.root', text: 'Other positive' },
			started,
		);
		const otherPath = join(root, 'logs/runtime-faults/current.jsonl');
		const retained = await readFile(otherPath, 'utf8');
		// This is the explicitly created child of the verified disposable fixture root.
		await rm(originating, { recursive: true });
		const refused = await rejection(
			delivery.report({ level: 'error', source: 'fixture.root', text: 'Late origin' }),
		);
		await delivery.flush();
		expect(refused.message).toBe('Runtime fault team root is missing.');
		expect(unavailable).toBe(1);
		expect(await readFile(otherPath, 'utf8')).toBe(retained);
		expect(await rejection(lstat(originating))).toMatchObject({ code: 'ENOENT' });
	}));
