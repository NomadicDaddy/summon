import { app, BrowserWindow } from 'electron';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('Missing disposable fixture root');
/*
 * Each step is also written to trace.txt beside the fixture. The verdict still travels on stdout,
 * so the test's assertions are unchanged; the trace is what a failure reports. It tells an Electron
 * that quit before ready or before loading from a verdict printed and lost (#12656, #12690: one
 * gate failure with exit 0 and an empty stdout, then 1 of 40 standalone runs; cause unknown).
 */
const trace = (step: string): void => {
	appendFileSync(join(root, 'trace.txt'), `${String(Date.now())} ${step}\n`);
};
trace('start');
app.on('before-quit', () => {
	trace('before-quit');
});
app.on('will-quit', () => {
	trace('will-quit');
});
process.on('exit', (code) => {
	trace(`exit ${String(code)}`);
});
app.setPath('userData', join(root, 'electron-profile'));
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
	trace('ready');
	const window = new BrowserWindow({
		show: false,
		width: 1000,
		height: 700,
		webPreferences: { offscreen: true, sandbox: true },
	});
	try {
		await window.loadFile(join(root, 'page-shift.html'));
		trace('loaded');
		// The renderer fixture awaits its scroll cases, so poll for its verdict.
		let title: unknown = '';
		for (let waited = 0; waited < 8000; waited += 100) {
			title = (await window.webContents.executeJavaScript('document.title')) as unknown;
			if (title === 'PAGE_SHIFT_PASS' || String(title).startsWith('FAIL')) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		trace(`title ${String(title)}`);
		if (title !== 'PAGE_SHIFT_PASS')
			throw new Error(`Renderer fixture failed: ${String(title)}`);
		console.log('PAGE_SHIFT_PASS');
		trace('printed');
		window.destroy();
		app.quit();
	} catch (error: unknown) {
		trace(`error ${String(error)}`);
		console.error(error);
		window.destroy();
		// Not process.exitCode with app.quit(): measured, a failed load then never exits and is
		// killed at the test's deadline. app.exit(1) ends it at once with 1. When a quit is
		// already under way Electron still reports 0 either way, which is the shape of the one
		// gate failure; the test therefore prints this trace and stderr whenever the verdict is
		// missing, instead of only when the exit code is not 0.
		app.exit(1);
	}
});
