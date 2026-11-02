import { expect, test } from 'bun:test';

import { reconcileResponseEpisode, responseEpisodePhase } from '../src/response-watchdog-model.ts';

const id = '11111111-1111-4111-8111-111111111111';
const observation = { id: 'mail:one', condition: 'blocked' as const, progress: 0 };
const input = {
	owner: 'fixture',
	nonce: 'launch',
	id,
	now: 0,
	suspended: false,
	observations: [observation],
};

test('blocked work escalates once and a send does not reset its age', () => {
	const initial = reconcileResponseEpisode(undefined, input);
	const waiting = reconcileResponseEpisode(initial, { ...input, now: 300000 });
	expect(responseEpisodePhase(waiting, 300000)).toBe('waiting');
	const sent = reconcileResponseEpisode(waiting, {
		...input,
		now: 600000,
		observations: [{ ...observation, condition: 'awaiting-read' }],
	});
	expect(responseEpisodePhase(sent, 600000)).toBe('attention');
	expect(sent.expectations[0]?.progressAt).toBe(0);
	expect(reconcileResponseEpisode(sent, { ...input, now: 700000 }).id).toBe(id);
});

test('new arrivals and replay cannot postpone oldest work; relevant progress can', () => {
	const initial = reconcileResponseEpisode(undefined, input);
	const more = reconcileResponseEpisode(initial, {
		...input,
		now: 500000,
		observations: [observation, { ...observation, id: 'mail:two' }],
	});
	expect(more.expectations[0]?.progressAt).toBe(0);
	const progress = reconcileResponseEpisode(more, {
		...input,
		now: 550000,
		observations: [{ ...observation, progress: 1 }],
	});
	expect(progress.expectations[0]?.progressAt).toBe(550000);
	expect(responseEpisodePhase(progress, 600000)).toBe('observing');
});

test('suspension and replacement give fresh windows; dismissal is not a read', () => {
	const initial = reconcileResponseEpisode(undefined, input);
	const paused = reconcileResponseEpisode(initial, { ...input, suspended: true, now: 900000 });
	expect(responseEpisodePhase(paused, 900000)).toBe('suspended');
	expect(paused.alerted).toBe(false);
	const resumed = reconcileResponseEpisode(paused, { ...input, now: 1000000 });
	expect(resumed.expectations[0]?.progressAt).toBe(1000000);
	const dismissed = { ...resumed, dismissed: true };
	expect(reconcileResponseEpisode(dismissed, { ...input, now: 2000000 }).dismissed).toBe(true);
	expect(dismissed.expectations).toHaveLength(1);
	const replaced = reconcileResponseEpisode(dismissed, {
		...input,
		nonce: 'replacement',
		now: 2000000,
	});
	expect(replaced.dismissed).toBe(false);
	expect(replaced.expectations[0]?.progressAt).toBe(2000000);
});

test('progress after an alert hides it until the wait expires again without replacing its episode', () => {
	const initial = reconcileResponseEpisode(undefined, input);
	const alert = reconcileResponseEpisode(initial, { ...input, now: 600000 });
	expect(responseEpisodePhase(alert, 600000)).toBe('attention');
	const progress = reconcileResponseEpisode(alert, {
		...input,
		now: 660000,
		observations: [{ ...observation, progress: 1 }],
	});
	expect(progress.id).toBe(alert.id);
	expect(progress.alerted).toBe(true);
	expect(progress.episodeTargets).toEqual(alert.episodeTargets);
	expect(progress.expectations).toHaveLength(1);
	expect(responseEpisodePhase(progress, 660000)).toBe('observing');
	expect(responseEpisodePhase(progress, 960000)).toBe('waiting');
	expect(responseEpisodePhase(progress, 1259999)).toBe('waiting');
	expect(responseEpisodePhase(progress, 1260000)).toBe('attention');
	expect(responseEpisodePhase({ ...progress, dismissed: true }, 1260000)).toBe('dismissed');
});

test('progress on one target cannot hide another overdue target', () => {
	const second = { ...observation, id: 'mail:two' };
	const observations = [observation, second];
	const initial = reconcileResponseEpisode(undefined, { ...input, observations });
	const alert = reconcileResponseEpisode(initial, { ...input, observations, now: 600000 });
	const progress = reconcileResponseEpisode(alert, {
		...input,
		now: 660000,
		observations: [{ ...observation, progress: 1 }, second],
	});
	expect(responseEpisodePhase(progress, 660000)).toBe('attention');
	expect(progress.expectations[1]?.progressAt).toBe(0);
});

test('empty inventory clears episode and backward clock restarts conservatively', () => {
	const initial = reconcileResponseEpisode(undefined, { ...input, now: 1000 });
	const rollback = reconcileResponseEpisode(initial, { ...input, now: 500 });
	expect(rollback.expectations[0]?.progressAt).toBe(500);
	const clear = reconcileResponseEpisode(rollback, { ...input, observations: [], now: 600 });
	expect(responseEpisodePhase(clear, 600)).toBe('clear');
});

for (const dismissed of [false, true]) {
	test(`satisfying the alert cohort ends its dismissal=${dismissed} even with newer pending work`, () => {
		const initial = reconcileResponseEpisode(undefined, input);
		const alert = reconcileResponseEpisode(initial, { ...input, now: 600000 });
		alert.dismissed = dismissed;
		const newer = { ...observation, id: 'mail:two' };
		const withNew = reconcileResponseEpisode(alert, {
			...input,
			now: 610000,
			observations: [observation, newer],
		});
		const remaining = reconcileResponseEpisode(withNew, {
			...input,
			id: '22222222-2222-4222-8222-222222222222',
			now: 620000,
			observations: [newer],
		});
		expect(remaining.id).not.toBe(alert.id);
		expect(remaining.dismissed).toBe(false);
		expect(responseEpisodePhase(remaining, 620000)).toBe('observing');
		const later = reconcileResponseEpisode(remaining, {
			...input,
			now: 1210000,
			observations: [newer],
		});
		expect(responseEpisodePhase(later, 1210000)).toBe('attention');
	});
}
