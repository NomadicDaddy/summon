import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import type { CheckpointPackage, CheckpointState } from '../src/checkpoint-package-model.ts';

import { checkpointOutput } from '../src/checkpoint-output.ts';
import { checkpointText } from '../src/checkpoint-text.ts';
import {
	CATCH_UP_ITEMS,
	CATCH_UP_PAGES,
	CHECKPOINT_WORK_INSTRUCTION,
} from '../src/checkpoint-work.ts';

/** A package of `pages` pages holding `items` routine items, none addressed to the reader. */
function packageOf(pages: number, items: number): CheckpointPackage {
	return {
		version: 1,
		owner: 'alpha',
		id: randomUUID(),
		createdAt: new Date().toISOString(),
		items: Array.from({ length: items }, (_, index) => ({
			source: 'room' as const,
			id: String(index + 1),
			sha256: 'a'.repeat(64),
			bytes: 1,
			forMe: false,
			presentation: 'exact' as const,
			firstPage: 0,
			lastPage: 0,
			parts: 1,
		})),
		pages: Array.from({ length: pages }, () => ({
			receipt: randomUUID(),
			payload: { room: { events: [] } },
			completeMail: [],
		})),
		finalReceipt: randomUUID(),
		sources: { room: { from: 0, through: 0 }, holds: {} },
	};
}

function adviceFor(pages: number, items: number): string | undefined {
	const packet = packageOf(pages, items);
	const state: CheckpointState = {
		version: 2,
		current: { id: packet.id, sha256: 'a'.repeat(64), page: 0 },
		seenHolds: {},
	};
	const output = checkpointOutput(packet, state, false, false);
	expect(output.package.pages).toBe(pages);
	expect(output.package.items).toBe(items);
	return output.catchUpAdvice;
}

const OVER = 'over the catch-up threshold';
const MAY = 'you may preview an explicit skip';

test('the threshold is the approved more than 5 pages or more than 200 items', () => {
	expect(CATCH_UP_PAGES).toBe(5);
	expect(CATCH_UP_ITEMS).toBe(200);
});

test('at and below both limits a large package only suggests catch-up', () => {
	// Four and five pages keep the existing suggestion, and say so in the counters shown.
	for (const pages of [4, 5]) {
		const advice = String(adviceFor(pages, 200));
		expect(advice).toContain(`This package has ${String(pages)} pages and 200 items.`);
		expect(advice).toContain(MAY);
		expect(advice).not.toContain(OVER);
	}
	// Small packages within both limits get no advice at all.
	expect(adviceFor(3, 200)).toBeUndefined();
	expect(adviceFor(1, 0)).toBeUndefined();
});

test('one page past the page limit tells the seat to use catch-up', () => {
	const advice = String(adviceFor(6, 10));
	expect(advice).toContain('This package has 6 pages and 10 items.');
	expect(advice).toContain(OVER);
	expect(advice).toContain('more than 5 pages or more than 200 items');
	expect(advice).toContain('use an explicit catch-up instead of reading page by page');
	expect(advice).not.toContain(MAY);
});

test('one item past the item limit triggers it even in a short package', () => {
	expect(adviceFor(2, 200)).toBeUndefined();
	const advice = String(adviceFor(2, 201));
	expect(advice).toContain('This package has 2 pages and 201 items.');
	expect(advice).toContain(OVER);
});

test('over the threshold the advice keeps every safeguard and stays visible in text', () => {
	const packet = packageOf(7, 300);
	const state: CheckpointState = {
		version: 2,
		current: { id: packet.id, sha256: 'a'.repeat(64), page: 0 },
		seenHolds: {},
	};
	const output = checkpointOutput(packet, state, false, true);
	for (const part of [
		'summon --checkpoint catch-up list <plan-id>',
		'read each one with the exact read command its entry gives',
		'summon --checkpoint catch-up apply <plan-id>',
		'recorded as skipped, never as read, handled or approved',
		'your mail keeps its own state',
		'do not retry in a loop or work around it',
		'read this page and pass its receipt',
	])
		expect(String(output.catchUpAdvice)).toContain(part);
	expect(checkpointText(output, true)).toContain(OVER);
	// The page still carries its own receipt instruction; advice never replaces it.
	expect(output.package.instruction).toContain(
		'Read this entire page before passing its receipt.',
	);
});

test('the work instruction names the same measurable threshold', () => {
	expect(CHECKPOINT_WORK_INSTRUCTION).toContain(
		'When a package has more than 5 pages or more than 200 items (the package.pages and package.items a checkpoint page reports), use summon --checkpoint catch-up instead of paging',
	);
	expect(CHECKPOINT_WORK_INSTRUCTION).toContain('direct mail stays unchanged');
	expect(CHECKPOINT_WORK_INSTRUCTION).not.toContain('deep routine-history backlog');
});
