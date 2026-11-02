import { expect, test } from 'bun:test';

import type { TeamEvent } from '../src/desktop/types.ts';

import { setupErrorBanner } from '../src/desktop/error-banner.ts';
import { runtimeFaultDelivery } from '../src/desktop/runtime-fault-delivery.ts';
import { faultStore, noteFault } from '../src/desktop/teammate-faults.ts';
import { appendRuntimeFault, readRuntimeFaults } from '../src/runtime-faults.ts';
import { runtimeFaultDom } from './fixtures/runtime-fault-dom.ts';
import { runtimeFaultFixture as fixture } from './fixtures/runtime-fault-test.ts';

const started = '2026-10-06T20:00:00.000Z';

test('main wake delivery retains the member fault before emission and never captures terminal output', async () =>
	fixture(async () => {
		const visible: TeamEvent[] = [];
		const snapshots: ReturnType<typeof readRuntimeFaults>[] = [];
		const delivery = runtimeFaultDelivery(
			() => started,
			(event) => {
				visible.push(event);
				if (event.type === 'error') snapshots.push(readRuntimeFaults({ limit: 50 }));
			},
		);
		delivery.send({ type: 'output', slug: 'member_1', data: 'TEST_PRIVATE_TERMINAL' });
		delivery.send({
			type: 'error',
			source: 'wake.receiver-cycle',
			slug: 'member_1',
			message: 'Receiver input is uncertain.',
		});
		await delivery.flush();
		await Promise.resolve();
		expect(snapshots).toHaveLength(1);
		const snapshot = await snapshots[0];
		expect(snapshot).toMatchObject({
			retainedOccurrences: 1,
			entries: [{ source: 'wake.receiver-cycle', member: 'member_1' }],
		});
		expect(JSON.stringify(snapshot)).not.toContain('TEST_PRIVATE_TERMINAL');
		expect(visible).toContainEqual({
			type: 'error',
			source: 'wake.receiver-cycle',
			slug: 'member_1',
			message: 'Receiver input is uncertain.',
			diagnosticHandled: true,
			diagnosticSaved: true,
		});
	}));

test('main-only recovery clears the persistence notice without a frontend report and a later failure reopens it', async () =>
	fixture(async () =>
		runtimeFaultDom(async ({ element, reports, events }) => {
			const banner = setupErrorBanner(element);
			const faults = faultStore();
			let fail = true;
			const delivery = runtimeFaultDelivery(
				() => started,
				(event) => {
					if (event.type === 'error') noteFault(faults, event, banner, () => {});
				},
				(input, at) =>
					fail
						? Promise.reject(new Error('TEST_STORAGE_FAILURE'))
						: appendRuntimeFault(input, at),
			);
			const send = async (): Promise<void> => {
				delivery.send({ type: 'error', message: 'Wake failed.', slug: 'alice' });
				await delivery.flush();
				await Promise.resolve();
			};
			await send();
			expect(element('fault-notice').hidden).toBe(false);
			expect(element('error-message').textContent).toBe('Wake failed.');
			expect(events).toHaveLength(1);
			fail = false;
			await send();
			expect(element('fault-notice').hidden).toBe(true);
			expect((await readRuntimeFaults({ limit: 50 })).retainedOccurrences).toBe(1);
			fail = true;
			await send();
			expect(element('fault-notice').hidden).toBe(false);
			expect(events).toHaveLength(2);
			fail = false;
			await send();
			expect(element('fault-notice').hidden).toBe(true);
			expect(reports).toHaveLength(0);
			expect((await readRuntimeFaults({ limit: 50 })).retainedOccurrences).toBe(2);
		}),
	));
