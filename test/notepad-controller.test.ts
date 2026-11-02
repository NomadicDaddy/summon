import { afterEach, beforeEach, expect, test } from 'bun:test';

import { notepadHarness } from './fixtures/notepad-controller.ts';

let h: Awaited<ReturnType<typeof notepadHarness>>;
beforeEach(async () => {
	h = await notepadHarness();
});
afterEach(async () => {
	await h.dispose();
});

test('every open rereads disk, including a reopen while the preceding read is pending', async () => {
	const entered = Promise.withResolvers<undefined>();
	const gate = Promise.withResolvers<undefined>();
	const read = h.port.read;
	let calls = 0;
	h.port.read = async () => {
		const disk = await read();
		if (++calls === 1) {
			entered.resolve(undefined);
			await gate.promise;
		}
		return disk;
	};
	const first = h.controller.load();
	await entered.promise;
	const second = h.controller.load();
	await h.outside('outside edit during the first read');
	gate.resolve(undefined);
	await Promise.all([first, second]);
	expect(calls).toBe(2);
	expect(h.controller.state.text).toBe('outside edit during the first read');
	expect(h.counts().saves).toBe(0);
});

test('pending verification rejects editor and preview edits without altering recovery', async () => {
	await h.controller.load();
	const entered = Promise.withResolvers<undefined>();
	const gate = Promise.withResolvers<undefined>();
	const read = h.port.read;
	h.port.read = async () => {
		entered.resolve(undefined);
		await gate.promise;
		return read();
	};
	const loading = h.controller.load();
	await entered.promise;
	h.controller.edit('unverified preview edit');
	const duringRead = h.controller.state.text;
	const rawDuringRead = h.raw();
	await h.controller.save();
	gate.resolve(undefined);
	await loading;
	expect(duringRead).toBe('original');
	expect(rawDuringRead).toBeNull();
	expect(h.counts().saves).toBe(0);
	expect(h.controller.state.text).toBe('original');
});

test('recovery access failure offers retry without treating an unseen draft as malformed', async () => {
	const stored = JSON.stringify({ text: 'recovered text', revision: (await h.disk()).revision });
	h.setRaw(stored);
	const read = h.recovery.read;
	h.recovery.read = () => {
		throw new Error('Recovery temporarily unavailable');
	};
	await h.controller.load();
	const failed = h.controller.notice.kind;
	const preserved = h.raw();
	h.recovery.read = read;
	await h.controller.load();
	expect(failed).toBe('read-failure');
	expect(preserved).toBe(stored);
	expect(h.controller.state.text).toBe('recovered text');
	expect(h.controller.notice.kind).toBe('quiet');
	expect(h.counts().saves).toBe(0);
});

test('read failure takes precedence over conflict and retries preserve both versions', async () => {
	await h.controller.load();
	h.controller.edit('my draft');
	await h.outside('outside');
	await h.controller.load();
	expect(h.controller.notice.kind).toBe('conflict');
	const read = h.port.read;
	h.port.read = () => {
		throw new Error('Read failed');
	};
	await h.controller.load();
	h.controller.keepDraft();
	await h.controller.save(true);
	expect(h.controller.notice.kind).toBe('read-failure');
	expect(h.controller.state.text).toBe('my draft');
	expect(h.counts().saves).toBe(0);
	h.port.read = read;
	await h.controller.load();
	expect(h.controller.notice.kind).toBe('conflict');
	expect(h.controller.state.conflict?.text).toBe('outside');
	await h.controller.load(true);
	expect(h.controller.state.text).toBe('outside');
	expect(h.raw()).toBeNull();
	expect(h.counts().saves).toBe(0);
});

test('a synchronous save and read failure clears its job and can recover and save later', async () => {
	await h.controller.load();
	h.controller.edit('retained draft');
	const save = h.port.save;
	const read = h.port.read;
	h.port.save = () => {
		throw new Error('Synchronous write failure');
	};
	h.port.read = () => {
		throw new Error('Synchronous read failure');
	};
	await h.controller.save();
	expect(h.controller.saving).toBe(false);
	expect(h.controller.notice.kind).toBe('read-failure');
	expect((await h.disk()).text).toBe('original');
	expect(h.controller.state.text).toBe('retained draft');
	h.port.save = save;
	h.port.read = read;
	await h.controller.load();
	await h.controller.save();
	expect((await h.disk()).text).toBe('retained draft');
	expect(h.controller.saving).toBe(false);
});

test('Keep refuses a second outside edit and surfaces changed-again instead of overwriting it', async () => {
	await h.controller.load();
	h.controller.edit('my draft');
	await h.outside('outside one');
	await h.controller.load();
	const save = h.port.save;
	h.port.save = async (text, revision) => {
		await h.outside('outside two');
		return save(text, revision);
	};
	h.controller.keepDraft();
	await h.controller.save();
	const notice = h.controller.notice;
	expect(notice.kind).toBe('conflict');
	if (notice.kind !== 'conflict') throw new Error('Missing conflict');
	expect(notice.changedAgain).toBe(true);
	expect(notice.diskText).toBe('outside two');
	expect(h.controller.state.text).toBe('my draft');
	expect((await h.disk()).text).toBe('outside two');
});

test('edits made during a save are serialized and a reopen waits for the final saved text', async () => {
	await h.controller.load();
	h.controller.edit('draft one');
	const entered = Promise.withResolvers<undefined>();
	const gate = Promise.withResolvers<undefined>();
	const save = h.port.save;
	let first = true;
	h.port.save = async (text, revision) => {
		const disk = await save(text, revision);
		if (first) {
			first = false;
			entered.resolve(undefined);
			await gate.promise;
		}
		return disk;
	};
	const saving = h.controller.save();
	await entered.promise;
	h.controller.edit('draft two');
	const opening = h.controller.load();
	gate.resolve(undefined);
	await Promise.all([saving, opening]);
	expect((await h.disk()).text).toBe('draft two');
	expect(h.controller.state.text).toBe('draft two');
	expect(h.counts().saves).toBe(2);
	expect(h.controller.loading).toBe(false);
	expect(h.controller.saving).toBe(false);
});

test('successful save remains saved if recovery cleanup fails', async () => {
	await h.controller.load();
	h.recovery.clear = () => {
		throw new Error('Storage cleanup unavailable');
	};
	h.controller.edit('saved text');
	await h.controller.save();
	expect((await h.disk()).text).toBe('saved text');
	expect(h.controller.notice.kind).toBe('quiet');
	expect(h.controller.status).toContain('Saved. Recovery cleanup unavailable.');
	await h.controller.load();
	expect(h.controller.state.text).toBe('saved text');
	expect(h.controller.notice.kind).toBe('quiet');
});
