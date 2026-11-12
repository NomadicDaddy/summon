import { app, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Drives room-follow-renderer: opens the Room, and for each distance from the bottom scrolls there,
// lets a new post arrive through the 1 s poll, and records where the view ends up and which post is
// at the top of the view before and after. Writes result.json, or error.txt on failure.
const [root] = process.argv.slice(2);
if (!root) throw new Error('Fixture root required.');
app.setPath('userData', join(root, 'profile'));
app.disableHardwareAcceleration();

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const DISTANCES = [0, 20, 40, 59, 61, 120, 400];

async function until(window: BrowserWindow, condition: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await window.webContents.executeJavaScript(condition)) as unknown) return;
		await delay(50);
	}
	throw new Error(`Room follow fixture did not reach: ${condition}`);
}

const VIEW = `(() => {
	const m = document.getElementById('room-messages');
	const box = m.getBoundingClientRect();
	const top = [...m.querySelectorAll('article')].find((a) => a.getBoundingClientRect().bottom > box.top + 1);
	return { fromBottom: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight), topPost: top?.id ?? null, count: m.querySelectorAll('article').length };
})()`;

void app.whenReady().then(async () => {
	const window = new BrowserWindow({
		show: false,
		useContentSize: true,
		width: 1200,
		height: 800,
		webPreferences: { offscreen: true, sandbox: true },
	});
	try {
		await window.loadFile(join(root, 'index.html'));
		await until(window, "document.title === 'ROOM_FOLLOW_READY'");
		await until(window, "document.querySelectorAll('#room-messages article').length === 60");
		await window.webContents.executeJavaScript(
			"document.querySelector('#room-toggle')?.click()",
		);
		await delay(300);
		const rows: unknown[] = [];
		for (const distance of DISTANCES) {
			await window.webContents.executeJavaScript(`(() => {
				const m = document.getElementById('room-messages');
				m.scrollTop = m.scrollHeight - m.clientHeight - ${distance};
			})()`);
			await delay(200);
			const before = (await window.webContents.executeJavaScript(VIEW)) as Record<
				string,
				unknown
			>;
			const id = (await window.webContents.executeJavaScript(
				'window.addFixturePost()',
			)) as number;
			await until(window, `!!document.getElementById('room-message-${id}')`);
			await delay(300);
			const after = (await window.webContents.executeJavaScript(VIEW)) as Record<
				string,
				unknown
			>;
			rows.push({ distance, before, after });
		}
		// Roger #44445: the reader is at the bottom when a read starts, scrolls up 200 px while it is
		// in flight, and the read then brings a new post. The reader must stay where they scrolled.
		await window.webContents.executeJavaScript(`(() => {
			const m = document.getElementById('room-messages');
			m.scrollTop = m.scrollHeight;
			window.readDelay = 1500;
		})()`);
		await until(window, 'window.readInFlight === true');
		await window.webContents.executeJavaScript(`(() => {
			const m = document.getElementById('room-messages');
			m.scrollTop = m.scrollHeight - m.clientHeight - 200;
		})()`);
		await delay(100);
		const before = (await window.webContents.executeJavaScript(VIEW)) as Record<
			string,
			unknown
		>;
		const id = (await window.webContents.executeJavaScript(
			'window.addFixturePost()',
		)) as number;
		await until(window, `!!document.getElementById('room-message-${id}')`);
		await delay(300);
		const after = (await window.webContents.executeJavaScript(VIEW)) as Record<string, unknown>;
		rows.push({ distance: 'scrolled-during-read', before, after });
		await writeFile(join(root, 'result.json'), JSON.stringify(rows, null, 2));
	} catch (cause: unknown) {
		await writeFile(join(root, 'error.txt'), String(cause));
	} finally {
		app.exit(0);
	}
});
