import { expect, test } from 'bun:test';

import type { PaneSwitchDiagnostic } from '../src/desktop/mention-scan-metrics.ts';
import type { SelectTiming, TeamSnapshot } from '../src/desktop/types.ts';

import {
	createMentionScanRecorder,
	paneSwitchDiagnostic,
} from '../src/desktop/mention-scan-metrics.ts';
import { paneSwitch } from '../src/desktop/pane-switch.ts';

// #47527: a teammate switch waited for main's full roster snapshot before the pane changed.
function snapshotFor(selected: string): TeamSnapshot {
	return {
		selected,
		agents: [{ slug: 'ada' }, { slug: 'bo' }, { slug: 'cy' }],
	} as unknown as TeamSnapshot;
}

function harness() {
	let time = 1_000;
	const rendered: string[] = [];
	const reports: PaneSwitchDiagnostic[] = [];
	const frames: (() => void)[] = [];
	const waits: (() => void)[] = [];
	const selects: {
		slug: string;
		clickedAt: number;
		resolve: (timing: SelectTiming) => void;
		reject: (error: Error) => void;
	}[] = [];
	const view = paneSwitch({
		render: (snapshot) => rendered.push(snapshot.selected),
		select: (slug, clickedAt) =>
			new Promise<SelectTiming>((resolve, reject) =>
				selects.push({ slug, clickedAt, resolve, reject }),
			),
		action: async (run) => {
			try {
				await run();
				return true;
			} catch {
				return false;
			}
		},
		report: (record) => reports.push(record),
		now: () => time,
		clock: () => 1_700_000_000_000 + time,
		frame: (callback) => frames.push(callback),
		wait: () =>
			new Promise<void>((resolve) => {
				waits.push(resolve);
			}),
	});
	return {
		view,
		rendered,
		reports,
		selects,
		advance: (ms: number) => {
			time += ms;
		},
		flushFrames: () => {
			while (frames.length) frames.shift()?.();
		},
		expireWaits: () => {
			while (waits.length) waits.shift()?.();
		},
	};
}

// The record is written after the paint sample settles, a few microtasks after the select.
async function settled(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) await Promise.resolve();
}

test('a click paints the new pane before main answers, and the record splits the delay', async () => {
	const h = harness();
	h.view.snapshot(snapshotFor('ada'));
	h.view.preview('bo');
	expect(h.rendered).toEqual(['bo']);
	h.advance(16);
	h.flushFrames();
	const done = h.view.select('bo');
	expect(h.selects).toHaveLength(1);
	h.advance(2_984);
	h.selects[0]?.resolve({ ipcWaitMs: 2_400, selectMs: 580 });
	expect(await done).toBe(true);
	await settled();
	expect(h.reports).toEqual([
		{
			kind: 'switch',
			at: new Date(1_700_000_001_000).toISOString(),
			durationMs: 3_000,
			paintMs: 16,
			ipcWaitMs: 2_400,
			selectMs: 580,
			outcome: 'complete',
		},
	]);
	expect(h.selects[0]?.clickedAt).toBe(1_700_000_001_000);
});

test('an older routine snapshot cannot flip the pane back while the switch is pending', async () => {
	const h = harness();
	h.view.snapshot(snapshotFor('ada'));
	h.view.preview('bo');
	expect(h.view.snapshot(snapshotFor('ada')).selected).toBe('bo');
	const done = h.view.select('bo');
	h.selects[0]?.resolve({ ipcWaitMs: 5, selectMs: 5 });
	await done;
	expect(h.view.snapshot(snapshotFor('ada')).selected).toBe('ada');
});

test('a failed select restores the real selection and is recorded as failed', async () => {
	const h = harness();
	h.view.snapshot(snapshotFor('ada'));
	h.view.preview('bo');
	const done = h.view.select('bo');
	h.selects[0]?.reject(new Error('Agent no longer exists.'));
	expect(await done).toBe(false);
	expect(h.rendered).toEqual(['bo', 'ada']);
	h.flushFrames();
	await settled();
	expect(h.reports[0]?.outcome).toBe('failed');
	expect(h.reports[0]?.ipcWaitMs).toBeNull();
});

test('a second click supersedes the first, and only the latest selection is held', async () => {
	const h = harness();
	h.view.snapshot(snapshotFor('ada'));
	h.view.preview('bo');
	const first = h.view.select('bo');
	h.view.preview('cy');
	const second = h.view.select('cy');
	expect(h.view.snapshot(snapshotFor('bo')).selected).toBe('cy');
	h.selects[0]?.resolve({ ipcWaitMs: 1, selectMs: 1 });
	h.selects[1]?.resolve({ ipcWaitMs: 1, selectMs: 1 });
	await Promise.all([first, second]);
	h.flushFrames();
	await settled();
	expect(h.reports.map((record) => record.outcome)).toEqual(['superseded', 'complete']);
	expect(h.rendered).toEqual(['bo', 'cy']);
});

test('a select that answers before the paint frame waits for its paint sample (Roger #47618)', async () => {
	const h = harness();
	h.view.snapshot(snapshotFor('ada'));
	h.view.preview('bo');
	const done = h.view.select('bo');
	h.advance(4);
	h.selects[0]?.resolve({ ipcWaitMs: 1, selectMs: 3 });
	expect(await done).toBe(true);
	await settled();
	expect(h.reports).toEqual([]);
	h.advance(12);
	h.flushFrames();
	await settled();
	expect(h.reports[0]?.paintMs).toBe(16);
	expect(h.reports[0]?.durationMs).toBe(4);
});

test('a paint frame that never comes is bounded: the switch is recorded without one', async () => {
	const h = harness();
	h.view.snapshot(snapshotFor('ada'));
	h.view.preview('bo');
	const done = h.view.select('bo');
	h.selects[0]?.resolve({ ipcWaitMs: 1, selectMs: 3 });
	await done;
	await settled();
	expect(h.reports).toEqual([]);
	h.expireWaits();
	await settled();
	expect(h.reports[0]?.paintMs).toBeNull();
	expect(h.reports[0]?.outcome).toBe('complete');
});

test('a switch record is written within a second, not on the 30-second timer (Morticia #47619)', async () => {
	const writes: string[] = [];
	const recorder = createMentionScanRecorder(
		'fixture.json',
		() => undefined,
		(_path, text) => {
			writes.push(text);
			return Promise.resolve();
		},
	);
	recorder.record({
		kind: 'switch',
		at: '2026-11-13T20:00:00.000Z',
		durationMs: 40,
		paintMs: 16,
		ipcWaitMs: 2,
		selectMs: 30,
		outcome: 'complete',
	});
	await Bun.sleep(1_200);
	expect(writes).toHaveLength(1);
	expect(writes[0]).toContain('"kind":"switch"');
});

// Shutdown (Morgan #47670): a switch main has already received is written by the quit flush at
// once, without waiting for the urgent timer. A click whose record is still waiting in the
// renderer for its paint sample hasn't reached main and isn't covered; that's the stated bound.
test('the quit flush writes a switch main has already received, without waiting', async () => {
	const writes: string[] = [];
	const recorder = createMentionScanRecorder(
		'fixture.json',
		() => undefined,
		(_path, text) => {
			writes.push(text);
			return Promise.resolve();
		},
	);
	recorder.record({
		kind: 'switch',
		at: '2026-11-13T20:00:00.000Z',
		durationMs: 40,
		paintMs: 16,
		ipcWaitMs: 2,
		selectMs: 30,
		outcome: 'complete',
	});
	expect(writes).toHaveLength(0);
	await recorder.flush();
	expect(writes).toHaveLength(1);
	expect(writes[0]).toContain('"kind":"switch"');
});

test('a click on a member the renderer does not know paints nothing early', () => {
	const h = harness();
	h.view.snapshot(snapshotFor('ada'));
	h.view.preview('zed');
	expect(h.rendered).toEqual([]);
});

test('main records a switch only in exactly its own shape and bounds', () => {
	const valid = {
		kind: 'switch',
		at: '2026-11-13T20:00:00.000Z',
		durationMs: 3_000,
		paintMs: 16,
		ipcWaitMs: null,
		selectMs: 580,
		outcome: 'complete',
	};
	expect(paneSwitchDiagnostic({ ...valid, extra: 'dropped' })).toEqual(
		valid as PaneSwitchDiagnostic,
	);
	for (const bad of [
		null,
		'switch',
		{ ...valid, kind: 'scan' },
		{ ...valid, at: 'not a time' },
		{ ...valid, durationMs: -1 },
		{ ...valid, durationMs: Number.NaN },
		{ ...valid, paintMs: 3_600_001 },
		{ ...valid, selectMs: '580' },
		{ ...valid, outcome: 'done' },
	])
		expect(paneSwitchDiagnostic(bad)).toBeNull();
});
