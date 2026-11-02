import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { runtimeFaultDelivery } from '../src/desktop/runtime-fault-delivery.ts';
import { runtimeFaultInput } from '../src/runtime-fault-model.ts';

test('shutdown drains a report enqueued while its earlier write is still pending', async () => {
	let releaseFirst = (): void => {};
	let releaseSecond = (): void => {};
	const first = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const second = new Promise<void>((resolve) => {
		releaseSecond = resolve;
	});
	let completed = 0;
	const started = '2026-10-06T20:00:00.000Z';
	const delivery = runtimeFaultDelivery(
		() => started,
		() => {},
		async (input) => {
			const entry = runtimeFaultInput.parse(input);
			await (entry.text === 'First.' ? first : second);
			completed++;
			return { ...entry, id: randomUUID(), at: started, windowStartedAt: started };
		},
	);
	const a = delivery.report({ level: 'error', source: 'window.action', text: 'First.' });
	let drained = false;
	const drain = delivery.flush().then(() => {
		drained = true;
	});
	const b = delivery.report({ level: 'error', source: 'window.action', text: 'Second.' });
	releaseFirst();
	await a;
	await Promise.resolve();
	expect(completed).toBe(1);
	expect(drained).toBe(false);
	releaseSecond();
	await Promise.all([b, drain]);
	expect(completed).toBe(2);
	expect(drained).toBe(true);
});
