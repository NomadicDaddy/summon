import { expect, test } from 'bun:test';

import { createWindowShutdown, settleStops } from '../src/desktop/window-shutdown.ts';

test('failed close waits for all stops, recovers once, and permits a complete retry', async () => {
	const polling = Promise.withResolvers<undefined>();
	const entered = Promise.withResolvers<undefined>();
	const remaining = Promise.withResolvers<undefined>();
	const calls: string[] = [];
	let fail = true;
	let prevented = 0;
	const shutdown = createWindowShutdown({
		stopPolling: async () => {
			calls.push('stop polling');
			await polling.promise;
		},
		startPolling: () => {
			calls.push('start polling');
		},
		setClosing: (value) => {
			calls.push(`closing ${String(value)}`);
		},
		stopSessions: () => {
			calls.push('stop sessions');
			entered.resolve(undefined);
			return fail ? [Promise.reject(new Error('fixture failure')), remaining.promise] : [];
		},
		recover: () => {
			calls.push('recover');
		},
		quit: () => {
			calls.push('quit');
		},
		error: () => {
			calls.push('error');
		},
	});
	const event = {
		preventDefault: () => {
			prevented++;
		},
	};
	shutdown.close(event);
	const first = shutdown.request();
	shutdown.close(event);
	expect(prevented).toBe(2);
	expect(calls).toEqual(['closing true']);
	polling.resolve(undefined);
	await entered.promise;
	await Promise.resolve();
	expect(calls).not.toContain('recover');
	shutdown.close(event);
	expect(prevented).toBe(3);
	remaining.resolve(undefined);
	await first;
	expect(calls).toEqual([
		'closing true',
		'stop polling',
		'stop sessions',
		'closing false',
		'recover',
		'start polling',
		'error',
	]);
	fail = false;
	await shutdown.request();
	expect(calls.at(-1)).toBe('quit');
	shutdown.close(event);
	expect(prevented).toBe(3);
	expect(calls.filter((call) => call === 'stop sessions')).toHaveLength(2);
});

test('settling owned sessions preserves all termination failures', async () => {
	const first = new Error('first');
	const second = new Error('second');
	const result: unknown = await settleStops([
		Promise.reject(first),
		Promise.reject(second),
	]).catch((error: unknown) => error);
	expect(result).toBeInstanceOf(AggregateError);
	if (!(result instanceof AggregateError)) throw new Error('Expected aggregate failure');
	expect(result.errors).toEqual([first, second]);
});
