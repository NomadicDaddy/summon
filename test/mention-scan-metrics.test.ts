import { expect, test } from 'bun:test';

import {
	createMentionScanRecorder,
	type MentionScanDiagnostic,
} from '../src/desktop/mention-scan-metrics.ts';

test('timing recorder retains a bounded content-free trail and counts dropped overlap history', async () => {
	const writes: string[] = [];
	const errors: unknown[] = [];
	const recorder = createMentionScanRecorder(
		'fixture.json',
		(error) => errors.push(error),
		(_path, text) => {
			writes.push(text);
			return Promise.resolve();
		},
	);
	for (let index = 0; index < 70; index++) {
		const sample: MentionScanDiagnostic = {
			kind: 'scan',
			at: '2026-11-12T00:00:00.000Z',
			durationMs: 10,
			stagesMs: { hibernation: 2, events: 3 },
			skippedTicks: 0,
			outcome: 'complete',
		};
		recorder.record(sample);
	}
	recorder.record({
		kind: 'overlap',
		at: '2026-11-12T00:00:01.000Z',
		activeStage: 'events',
		elapsedMs: 2_100,
		skippedTicks: 1,
	});
	await recorder.flush();
	expect(errors).toEqual([]);
	expect(writes).toHaveLength(1);
	const saved = JSON.parse(writes[0] ?? '') as {
		version: number;
		overlapTotal: number;
		records: MentionScanDiagnostic[];
	};
	expect(saved.version).toBe(1);
	expect(saved.overlapTotal).toBe(1);
	expect(saved.records).toHaveLength(64);
	expect(saved.records.at(-1)).toMatchObject({ kind: 'overlap', activeStage: 'events' });
});
