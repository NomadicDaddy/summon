import { expect, spyOn, test } from 'bun:test';

import { sendMessage } from '../src/mailbox.ts';
import { NotificationNotSentError } from '../src/notification-delivery.ts';
import * as store from '../src/wake-delivery-store.ts';
import * as failure from '../src/wake-failure.ts';
import { coalesceReceiver, releaseFixtureReceiver } from './fixtures/coalesce-receiver.ts';
import { useWakeFixture } from './fixtures/wake-failure.ts';

// Morticia's Info on 9a18433 (#28242): the receiver checks retained outcomes every cycle, so that
// read must not open failure notes. Own status still shows them.
useWakeFixture();

test('the receiver cycle reads retained outcomes without opening a failure note', async () => {
	const nonce = 'wake-failure-fixture';
	const projection = spyOn(failure, 'wakeFailureProjection');
	const retained = spyOn(store, 'wakeDeliveryRetained');
	const status = spyOn(store, 'wakeDeliveryStatus');
	try {
		const { cycle, sent } = await coalesceReceiver(
			nonce,
			{},
			{ fail: () => new NotificationNotSentError('draft') },
		);
		await sendMessage('alpha', 'alpha', 'Wake request.');
		await cycle();
		expect(sent).toHaveLength(0);
		expect(retained).toHaveBeenCalled();
		expect(status).not.toHaveBeenCalled();
		expect(projection).not.toHaveBeenCalled();

		const shown = await store.wakeDeliveryStatus('alpha', nonce);
		const refused = shown.unresolved.find((value) => value.state === 'not-sent');
		if (!refused) throw new Error('Missing the refused wake outcome.');
		expect(refused.failure).toEqual({ category: 'send-refused' });
		expect(projection).toHaveBeenCalled();
		expect(await Bun.file(failure.failurePath('alpha', refused.id)).exists()).toBe(true);
	} finally {
		projection.mockRestore();
		retained.mockRestore();
		status.mockRestore();
		await releaseFixtureReceiver();
	}
});
