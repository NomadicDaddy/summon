import { expect, test } from 'bun:test';

import type { ScheduleRow, ScheduleView } from '../src/schedule-view.ts';

import { setupScheduleView } from '../src/desktop/schedule-view-panel.ts';
import { scheduleFocusDom } from './fixtures/schedule-focus-dom.ts';

const row = (id: string, condition: ScheduleRow['condition'] = 'active'): ScheduleRow => ({
	id,
	title: id,
	prompt: `Instruction for ${id}`,
	everyMinutes: 60,
	condition,
	nextDueAt: 1000,
});
const view = (rows: ScheduleRow[] = [row('Alpha'), row('Beta')]): ScheduleView => ({
	readAt: 1000,
	owners: [{ slug: 'owner', name: 'Owner', schedules: rows }],
	without: [],
});
const settle = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

async function fixture(run: (dom: ReturnType<typeof scheduleFocusDom>) => Promise<void>) {
	const dom = scheduleFocusDom(view());
	try {
		setupScheduleView();
		dom.byId('schedules-toggle').click();
		await settle();
		await run(dom);
	} finally {
		dom.restore();
	}
}

test('refresh follows schedule identity across due, paused and owner ordering, preserving expansion and scroll', async () => {
	await fixture(async (dom) => {
		for (const next of [
			view(),
			view([row('Beta', 'due'), row('Alpha')]),
			view([row('Alpha'), row('Beta', 'paused')]),
			{
				...view(),
				owners: [
					{ slug: 'new', name: 'A new owner', schedules: [row('Beta')] },
					{ slug: 'owner', name: 'Owner', schedules: [row('Alpha')] },
				],
			},
		]) {
			const summary = dom.summary('Beta');
			const details = summary.parent;
			if (!details) throw new Error('Missing details');
			details.open = true;
			details.dispatchEvent(new Event('toggle'));
			summary.focus();
			dom.byId('schedules').scrollTop = 123;
			dom.setView(next);
			dom.refresh();
			await settle();
			expect(dom.active).toBe(dom.summary('Beta'));
			expect(dom.active).not.toBe(summary);
			expect(dom.summary('Beta').parent?.open).toBe(true);
			expect(dom.byId('schedules').scrollTop).toBe(123);
		}
	});
});

test('removed focused schedule falls back to enabled Refresh even when the old index still exists', async () => {
	await fixture(async (dom) => {
		dom.summary('Alpha').focus();
		dom.setView(view([row('Beta')]));
		dom.refresh();
		await settle();
		const refresh = dom.byId('schedules').querySelector('button');
		if (!refresh) throw new Error('Missing Refresh button');
		expect(refresh.disabled).toBe(false);
		expect(dom.active).toBe(refresh);
		dom.summary('Beta').focus();
		dom.setView(view([]));
		dom.refresh();
		await settle();
		expect(dom.active).toBe(refresh);
	});
});

test('background refresh leaves outside controls focused, including changes during a pending read', async () => {
	await fixture(async (dom) => {
		dom.byId('outside').focus();
		dom.refresh();
		await settle();
		expect(dom.active).toBe(dom.byId('outside'));
		let resolve: (value: ScheduleView) => void = () => {
			throw new Error('No pending read');
		};
		dom.setReader(
			() =>
				new Promise<ScheduleView>((done) => {
					resolve = done;
				}),
		);
		dom.summary('Beta').focus();
		dom.refresh();
		const reads = dom.reads;
		dom.refresh();
		expect(dom.reads).toBe(reads);
		dom.byId('outside').focus();
		resolve(view([row('Beta'), row('Alpha')]));
		await settle();
		expect(dom.active).toBe(dom.byId('outside'));
	});
});

test('failed refresh retains focused row and retry restores identity without replacing outside focus', async () => {
	await fixture(async (dom) => {
		const focused = dom.summary('Beta');
		focused.focus();
		dom.setReader(() => Promise.reject(new Error('fixture read failure')));
		dom.refresh();
		await settle();
		expect(dom.active).toBe(focused);
		expect(dom.faults).toHaveLength(1);
		dom.setReader(() => Promise.resolve(view([row('Beta'), row('Alpha')])));
		dom.refresh();
		await settle();
		expect(dom.active).toBe(dom.summary('Beta'));
	});
});
