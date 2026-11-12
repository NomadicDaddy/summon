import { app, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [root, evidence] = process.argv.slice(2);
if (!root) throw new Error('Fixture root required.');
app.setPath('userData', join(root, 'profile'));
app.disableHardwareAcceleration();

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(window: BrowserWindow, condition: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await window.webContents.executeJavaScript(condition)) as unknown) return;
		await delay(50);
	}
	const title = (await window.webContents.executeJavaScript('document.title')) as unknown;
	throw new Error(`Room fixture did not reach: ${condition}; title=${String(title)}`);
}

async function click(window: BrowserWindow, selector: string): Promise<void> {
	await window.webContents.executeJavaScript(
		`document.querySelector(${JSON.stringify(selector)})?.click()`,
	);
}

async function fitViewport(window: BrowserWindow, width: number, height: number): Promise<void> {
	window.setContentSize(width, height);
	await delay(50);
	const measured = (await window.webContents.executeJavaScript(
		'({ width: innerWidth, height: innerHeight })',
	)) as { width: number; height: number };
	if (measured.width !== width || measured.height !== height)
		window.setContentSize(width * 2 - measured.width, height * 2 - measured.height);
	await delay(50);
}

void app.whenReady().then(async () => {
	await writeFile(join(root, 'progress.txt'), 'app ready');
	const window = new BrowserWindow({
		show: false,
		useContentSize: true,
		webPreferences: { offscreen: true, sandbox: true },
	});
	window.webContents.on('console-message', ({ message }) => {
		console.error('renderer:', message);
	});
	try {
		await writeFile(join(root, 'progress.txt'), 'window created');
		await window.loadFile(join(root, 'index.html'));
		await writeFile(join(root, 'progress.txt'), 'html loaded');
		await until(window, "document.title === 'ROOM_PLACE_READY'");
		await writeFile(join(root, 'progress.txt'), 'renderer ready');
		await until(window, "document.querySelectorAll('#room-messages article').length === 300");
		await click(window, '#room-toggle');
		await writeFile(join(root, 'progress.txt'), 'room opened');
		await until(window, "!!document.getElementById('room-message-120')");
		const beforeMark = (await window.webContents.executeJavaScript(
			"JSON.parse(localStorage.getItem('room-read-place:default'))",
		)) as { readThrough: number };
		if (beforeMark.readThrough !== 100)
			throw new Error('Opening the Room advanced the read marker.');
		await click(window, '#room-message-120 .room-mark-read');
		await until(
			window,
			"document.getElementById('room-read-status').textContent.includes('#120')",
		);
		await click(window, '#room-load-newer');
		await writeFile(join(root, 'progress.txt'), 'newer clicked');
		await until(window, "!!document.getElementById('room-message-140')");
		const checks = (await window.webContents.executeJavaScript(`({
			place: JSON.parse(localStorage.getItem('room-read-place:default')),
			badge: document.getElementById('room-unread').textContent,
			firstUnread: document.querySelector('.room-first-unread-divider')?.nextElementSibling?.id,
			leftAt: !!document.querySelector('#room-message-120 .room-left-off-marker'),
			older: !document.getElementById('room-load-older').disabled,
			newer: !document.getElementById('room-load-newer').disabled,
		})`)) as Record<string, unknown>;
		if (
			JSON.stringify(checks.place) !== JSON.stringify({ readThrough: 120, leftAt: 120 }) ||
			checks.badge !== '330' ||
			checks.firstUnread !== 'room-message-121' ||
			checks.leftAt !== true ||
			checks.older !== true ||
			checks.newer !== true
		)
			throw new Error(`Room place checks failed: ${JSON.stringify(checks)}`);
		const views: object[] = [];
		for (const [width, height] of [
			[2250, 1309],
			[1440, 900],
		] as const) {
			await fitViewport(window, width, height);
			for (const theme of ['dark', 'light']) {
				await window.webContents.executeJavaScript(
					`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`,
				);
				await delay(100);
				const measured = (await window.webContents.executeJavaScript(`({
					width: innerWidth, height: innerHeight,
					marker: getComputedStyle(document.querySelector('.room-left-off-marker')).color,
					divider: getComputedStyle(document.querySelector('.room-first-unread-divider')).color,
					scrollWidth: document.getElementById('room-place').scrollWidth,
					clientWidth: document.getElementById('room-place').clientWidth,
				})`)) as Record<string, unknown>;
				views.push({ ...measured, theme });
				if (evidence) {
					const image = await window.webContents.capturePage();
					await writeFile(
						join(evidence, `room-${width}-${height}-${theme}.png`),
						image.toPNG(),
					);
				}
			}
		}
		await click(window, '#room-load-older');
		await until(window, "!!document.getElementById('room-message-81')");
		for (let id = 160; id <= 440; id += 20) {
			await click(window, '#room-load-newer');
			await until(window, `!!document.getElementById('room-message-${id}')`);
		}
		await click(window, '#room-load-newer');
		await until(window, "!!document.getElementById('room-message-450')");
		const trimmedFirst = (await window.webContents.executeJavaScript(
			"Number(document.querySelector('#room-messages article')?.dataset.roomId)",
		)) as number;
		if (trimmedFirst !== 151)
			throw new Error(`Newer paging skipped or exceeded the transcript cap: ${trimmedFirst}`);
		await click(window, '#room-load-older');
		await until(window, "!!document.getElementById('room-message-131')");
		await click(window, '#room-load-newer');
		await until(window, "!!document.getElementById('room-message-450')");
		await click(window, '#room-show-latest');
		await until(window, "!!document.getElementById('room-message-450')");
		await click(window, '#room-message-450 .room-message-reply');
		await window.webContents.executeJavaScript(
			"document.getElementById('room-text').value = 'Fixture reply'; document.getElementById('room-form').requestSubmit()",
		);
		await delay(50);
		const afterReply = (await window.webContents.executeJavaScript(
			"JSON.parse(localStorage.getItem('room-read-place:default'))",
		)) as { readThrough: number };
		if (afterReply.readThrough !== 120)
			throw new Error('Sending a reply advanced the read marker.');
		const latestCount = (await window.webContents.executeJavaScript(
			"document.querySelectorAll('#room-messages article').length",
		)) as unknown;
		if (typeof latestCount !== 'number' || latestCount > 300)
			throw new Error(`Unbounded Room history: ${String(latestCount)}`);
		await click(window, '#room-close');
		const afterClose = (await window.webContents.executeJavaScript(
			"JSON.parse(localStorage.getItem('room-read-place:default'))",
		)) as { readThrough: number; leftAt: number };
		if (afterClose.readThrough !== 120 || afterClose.leftAt <= 120)
			throw new Error(`Closing changed the read marker: ${JSON.stringify(afterClose)}`);
		await click(window, '#room-toggle');
		await until(window, `!!document.getElementById('room-message-${afterClose.leftAt}')`);
		const afterReturn = (await window.webContents.executeJavaScript(
			"JSON.parse(localStorage.getItem('room-read-place:default'))",
		)) as { readThrough: number; leftAt: number };
		if (afterReturn.readThrough !== 120 || afterReturn.leftAt !== afterClose.leftAt)
			throw new Error(`Returning changed the place: ${JSON.stringify(afterReturn)}`);
		await window.webContents.executeJavaScript(
			"document.getElementById('room-first-unread').focus()",
		);
		window.webContents.focus();
		window.webContents.sendInputEvent({ keyCode: 'Enter', type: 'keyDown' });
		window.webContents.sendInputEvent({ keyCode: '\r', type: 'char' });
		window.webContents.sendInputEvent({ keyCode: 'Enter', type: 'keyUp' });
		await until(window, "document.activeElement?.id === 'room-message-121'");
		const visible = (await window.webContents.executeJavaScript(`(() => {
			const box = document.getElementById('room-messages').getBoundingClientRect();
			return [...document.querySelectorAll('#room-messages article[data-room-id]')]
				.filter((item) => { const b = item.getBoundingClientRect();
					return b.height > 0 && b.top >= box.top && b.bottom <= box.bottom; })
				.at(-1)?.dataset.roomId ?? null;
		})()`)) as string | null;
		if (visible === null) throw new Error('No whole message is visible.');
		await click(window, '#room-mark-visible');
		await until(
			window,
			`JSON.parse(localStorage.getItem('room-read-place:default')).readThrough === ${visible}`,
		);
		const saved = (await window.webContents.executeJavaScript(
			"JSON.parse(localStorage.getItem('room-read-place:default'))",
		)) as { leftAt: number; readThrough: number };
		await window.loadFile(join(root, 'index.html'));
		await until(window, "document.title === 'ROOM_PLACE_READY'");
		await until(
			window,
			`document.getElementById('room-read-status').textContent.includes('#${saved.readThrough}')`,
		);
		const restored = (await window.webContents.executeJavaScript(
			"JSON.parse(localStorage.getItem('room-read-place:default'))",
		)) as { leftAt: number; readThrough: number };
		if (restored.readThrough !== saved.readThrough || restored.leftAt !== Number(visible))
			throw new Error(`Window reload changed saved Room place: ${JSON.stringify(restored)}`);
		await writeFile(join(root, 'result.json'), JSON.stringify({ checks, views }));
	} catch (cause: unknown) {
		await writeFile(join(root, 'error.txt'), String(cause));
		process.exitCode = 1;
	} finally {
		window.destroy();
		app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
	}
});
