// Electron 44 exposes installation explicitly instead of downloading its binary in postinstall.
const installer = Bun.resolveSync('electron/install.js', import.meta.dir);
const child = Bun.spawn([process.execPath, installer], {
	stdin: 'ignore',
	stdout: 'inherit',
	stderr: 'inherit',
	windowsHide: true,
});
process.exitCode = await child.exited;
if (process.exitCode !== 0)
	console.error(
		'Electron runtime was not installed. A running Team Window can lock its files on Windows; close all Team Windows before retrying.',
	);
