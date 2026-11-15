// Drives the Room's reading-moves-the-marker behaviour (Phillip #46659, amended #51167 on #51137)
// in a disposable Electron window. The renderer starts with the marker at #100, 450 posts, and
// `window.roomAttend` standing in for the Window's focus and visibility.
import { app, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [root] = process.argv.slice(2);
if (!root) throw new Error('Fixture root required.');
app.setPath('userData', join(root, 'profile'));
app.disableHardwareAcceleration();

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

void app.whenReady().then(async () => {
	const window = new BrowserWindow({
		show: false,
		useContentSize: true,
		width: 1440,
		height: 900,
		webPreferences: { offscreen: true, sandbox: true },
	});
	const run = async <T>(script: string): Promise<T> =>
		(await window.webContents.executeJavaScript(script)) as T;
	const until = async (condition: string, label: string): Promise<void> => {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (await run<boolean>(condition)) return;
			await delay(50);
		}
		throw new Error(`Auto-read fixture did not reach ${label}: ${condition}`);
	};
	const marker = (): Promise<number | null> =>
		run<number | null>(
			"JSON.parse(localStorage.getItem('room-read-place:default') ?? '{}').readThrough ?? null",
		);
	const progress = (step: string): Promise<void> => writeFile(join(root, 'progress.txt'), step);
	const scrollTo = (expression: string): Promise<void> =>
		run(
			`(() => { const m = document.getElementById('room-messages'); m.scrollTop = ${expression}; })()`,
		);
	const fullyVisible = (): Promise<number[]> =>
		run<number[]>(`(() => {
			const box = document.getElementById('room-messages').getBoundingClientRect();
			return [...document.querySelectorAll('#room-messages article[data-room-id]')]
				.filter((item) => { const b = item.getBoundingClientRect();
					return b.height > 0 && b.top >= box.top && b.bottom <= box.bottom; })
				.map((item) => Number(item.dataset.roomId));
		})()`);
	const steps: Record<string, unknown> = {};
	try {
		await window.loadFile(join(root, 'index.html'));
		await until("document.title === 'ROOM_PLACE_READY'", 'renderer ready');
		await until("document.querySelectorAll('#room-messages article').length === 300", 'posts');

		// 1. Room closed, Window attending: nothing is read.
		await run('window.roomAttend = true');
		await delay(1600);
		steps.closed = await marker();
		if (steps.closed !== 100)
			throw new Error(`Closed Room moved the marker: ${String(steps.closed)}`);

		// 2. Room open on the saved place (#120), Window not attending: nothing is read.
		await run('window.roomAttend = false');
		await run("document.getElementById('room-toggle').click()");
		await until("!!document.getElementById('room-message-120')", 'left-off place');
		await delay(1600);
		steps.unfocused = await marker();
		if (steps.unfocused !== 100)
			throw new Error(`Unfocused Window moved the marker: ${String(steps.unfocused)}`);
		await progress('closed and unfocused held');

		// 3. Attending, but #101 is scrolled out of sight above the view: posts below a gap of unseen
		// posts are not read, however long they stay on screen.
		await run(
			"document.getElementById('room-message-115')?.scrollIntoView({ block: 'start' })",
		);
		await run('window.roomAttend = true');
		await delay(300);
		const gapView = await fullyVisible();
		if (gapView.includes(101)) throw new Error('Gap case shows #101; it cannot test a gap.');
		await delay(1600);
		steps.gap = { view: [gapView[0], gapView.at(-1)], marker: await marker() };
		if ((await marker()) !== 100)
			throw new Error(`Marker passed unseen posts: ${JSON.stringify(steps.gap)}`);
		await progress('gap held');

		// 4. Fast scroll: posts that pass through the view in under a second are not read.
		await run(
			"document.getElementById('room-message-101')?.scrollIntoView({ block: 'start' })",
		);
		await delay(150);
		await scrollTo('m.scrollTop + m.clientHeight * 3');
		await delay(1600);
		steps.fastScroll = await marker();
		if (steps.fastScroll !== 100)
			throw new Error(`Fast scroll read posts: ${String(steps.fastScroll)}`);
		await progress('fast scroll held');

		// 5. Dwell: #101 onwards held fully on screen for a second are read, through the last of the
		// unbroken run that was on screen, and no further.
		await run(
			"document.getElementById('room-message-101')?.scrollIntoView({ block: 'start' })",
		);
		await delay(200);
		const dwellView = await fullyVisible();
		await until(
			`JSON.parse(localStorage.getItem('room-read-place:default')).readThrough > 100`,
			'dwell advance',
		);
		await delay(600);
		const dwelt = await marker();
		steps.dwell = { view: [dwellView[0], dwellView.at(-1)], marker: dwelt };
		if (dwelt === null || !dwellView.includes(dwelt) || dwelt !== dwellView.at(-1))
			throw new Error(`Dwell read the wrong span: ${JSON.stringify(steps.dwell)}`);
		await progress('dwell advanced');

		// 6. The bottom of a history page is not the end of the Room: it reads what was seen only.
		const browsing = await run<boolean>("!document.getElementById('room-load-newer').hidden");
		if (browsing) {
			await scrollTo('m.scrollHeight');
			await delay(1600);
			steps.historyBottom = await marker();
			if ((steps.historyBottom as number) >= 450)
				throw new Error('The bottom of a history page marked the whole Room read.');
		}

		// 7. The bottom of the live Room, attended for a second, reads everything through the last post.
		await until("!document.getElementById('room-show-latest').disabled", 'Latest enabled');
		await run("document.getElementById('room-show-latest').click()");
		await until("document.getElementById('room-show-latest').hidden", 'live Room');
		await until("!!document.getElementById('room-message-450')", 'last post');
		await scrollTo('m.scrollHeight');
		await until(
			`JSON.parse(localStorage.getItem('room-read-place:default')).readThrough === 450`,
			'bottom read',
		);
		await until("document.getElementById('room-unread').textContent === ''", 'badge cleared');
		steps.bottom = { marker: await marker(), badge: '' };
		await progress('bottom read all');

		// 8. A post that arrives while the reader is scrolled up stays unread until it is reached.
		await scrollTo('0');
		await delay(300);
		const posted = await run<number>('window.roomFixturePost()');
		await until(
			`!!document.getElementById('room-message-${String(posted)}')`,
			'new post drawn',
		);
		await delay(1600);
		steps.scrolledUp = { posted, marker: await marker() };
		if ((await marker()) !== 450)
			throw new Error(
				`A post arriving above the reader was read: ${JSON.stringify(steps.scrolledUp)}`,
			);
		await scrollTo('m.scrollHeight');
		await until(
			`JSON.parse(localStorage.getItem('room-read-place:default')).readThrough === ${String(posted)}`,
			'new post read at bottom',
		);
		steps.reached = await marker();

		// 9. Never backwards: the explicit button still may, but reading never lowers the marker.
		await run(
			"document.getElementById('room-message-300')?.scrollIntoView({ block: 'start' })",
		);
		await delay(1600);
		steps.neverBack = await marker();
		if (steps.neverBack !== posted)
			throw new Error(`Reading moved the marker back: ${String(steps.neverBack)}`);
		await writeFile(join(root, 'result.json'), JSON.stringify(steps));
	} catch (cause: unknown) {
		await writeFile(join(root, 'error.txt'), `${String(cause)} ${JSON.stringify(steps)}`);
		process.exitCode = 1;
	} finally {
		window.destroy();
		app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
	}
});
