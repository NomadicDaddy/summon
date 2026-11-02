import { afterEach, beforeEach, expect, test } from 'bun:test';

import { notepadHarness } from './fixtures/notepad-controller.ts';

let h: Awaited<ReturnType<typeof notepadHarness>>;
beforeEach(async () => {
	h = await notepadHarness();
});
afterEach(async () => {
	await h.dispose();
});

test('an empty stored recovery value remains invalid until explicit discard', async () => {
	h.setRaw('');
	await h.controller.load();
	expect(h.controller.notice.kind).toBe('invalid-draft');
	expect(h.raw()).toBe('');
	expect(h.counts().saves).toBe(0);
	await h.controller.load(true);
	expect(h.raw()).toBeNull();
	expect(h.controller.state.text).toBe('original');
});

test('malformed recovery stays untouched until explicit discard after a fresh read', async () => {
	h.setRaw('{invalid');
	await h.controller.load();
	expect(h.controller.notice.kind).toBe('invalid-draft');
	expect(h.raw()).toBe('{invalid');
	await h.outside('new disk');
	await h.controller.save(true);
	expect(h.counts().saves).toBe(0);
	await h.controller.load(true);
	expect(h.raw()).toBeNull();
	expect(h.controller.state.text).toBe('new disk');
	expect(h.controller.notice.kind).toBe('quiet');
});

test('discard refuses a recovery draft that changed while disk was being read', async () => {
	h.setRaw('{invalid');
	await h.controller.load();
	const replacement = JSON.stringify({
		text: 'new recovery',
		revision: (await h.disk()).revision,
	});
	const read = h.port.read;
	h.port.read = async () => {
		h.setRaw(replacement);
		return read();
	};
	await h.controller.load(true);
	expect(h.controller.notice.kind).toBe('read-failure');
	expect(h.raw()).toBe(replacement);
	expect(h.counts().saves).toBe(0);
	h.port.read = read;
	await h.controller.load();
	expect(h.controller.state.text).toBe('new recovery');
	expect(h.controller.notice.kind).toBe('quiet');
});

test('failed disk read during discard retains the exact malformed recovery', async () => {
	h.setRaw('{invalid');
	await h.controller.load();
	h.port.read = () => {
		throw new Error('Disk is unavailable');
	};
	await h.controller.load(true);
	expect(h.raw()).toBe('{invalid');
	expect(h.controller.notice.kind).toBe('read-failure');
	expect(h.counts().saves).toBe(0);
});
