import { expect, test } from 'bun:test';

import { mailHarness } from './fixtures/mail-harness.ts';

test('--msg posts as CLI without launches, rejects impersonation, and respects halt', async () => {
	const fixture = await mailHarness();
	try {
		const sent = await fixture.run(['--msg', 'ZYX is done!']);
		expect(sent.code).toBe(0);
		expect(sent.out).toContain('Team Room #1');
		const read = await fixture.run(['--room', 'read'], 'alpha');
		const page = JSON.parse(read.out) as {
			events: { sender: { kind: string; id: string }; text: string }[];
		};
		expect(page.events[0]?.sender).toEqual({ kind: 'cli', id: 'CLI' });
		expect(page.events[0]?.text).toBe('ZYX is done!');
		expect((await fixture.run(['--msg', 'pretend'], 'alpha')).code).not.toBe(0);
		for (const args of [
			['--msg'],
			['--msg', ''],
			['--msg', 'one', 'two'],
			['--msg', 'x'.repeat(4097)],
		])
			expect((await fixture.run(args)).code).not.toBe(0);
		expect((await fixture.run(['--comms', 'halt'])).code).toBe(0);
		expect((await fixture.run(['--msg', 'proceed'])).code).not.toBe(0);
		expect((await fixture.run(['--comms', 'proceed'])).code).toBe(0);
		expect((await fixture.run(['--msg', 'halt'])).code).toBe(0);
		expect((await fixture.run(['--msg', 'still open'])).code).toBe(0);
		const history = JSON.parse(await fixture.read('room/events.json')) as unknown[];
		expect(history).toHaveLength(3);
		expect(await Bun.file(fixture.capture).text()).toBe('');
	} finally {
		await fixture.dispose();
	}
});
