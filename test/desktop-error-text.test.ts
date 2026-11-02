import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';

import { setupErrorBanner } from '../src/desktop/error-banner.ts';
import { runtimeFaultDom } from './fixtures/runtime-fault-dom.ts';

/*
 * The Team Window's failures used to reach the operator as Electron's transport wrapper:
 *
 *   Error invoking remote method 'team:stop': Error: The session is not running.
 *
 * readableError() already stripped it, but only Maintenance and the head-down bar called it. Every
 * renderer module now does, so this scans for the two hand-rolled shapes that bypassed it.
 */
const DESKTOP = 'src/desktop';

async function rendererSources(): Promise<{ file: string; text: string }[]> {
	const files = (await readdir(DESKTOP)).filter((file) => file.endsWith('.ts'));
	return Promise.all(
		files.map(async (file) => ({ file, text: await Bun.file(`${DESKTOP}/${file}`).text() })),
	);
}

// Main-process and preload modules see the original error, not an IPC rejection, and
// mention-recovery rewraps an error rather than showing one.
const NOT_RENDERER = new Set([
	'ipc-error.ts',
	'mention-recovery.ts',
	'preload.ts',
	'team-snapshot.ts',
	'team-wake-errors.ts',
	'team.ts',
	'window.ts',
]);

describe('the Team Window shows the reason, not the transport', () => {
	test('no renderer module writes a raw error message to the screen', async () => {
		const offenders: string[] = [];
		for (const { file, text } of await rendererSources()) {
			if (NOT_RENDERER.has(file)) continue;
			for (const raw of [
				/\b(?:error|cause) instanceof Error \? (?:error|cause)\.message : String\(/u,
				/textContent = String\((?:error|cause)\)/u,
				/\$\{String\((?:error|cause)\)\}/u,
				/window\.alert\(String\(/u,
			])
				if (raw.test(text)) offenders.push(`${file}: ${raw.source}`);
		}
		expect(offenders).toEqual([]);
	});

	test('the shared error banner reads every error through readableError', async () => {
		await runtimeFaultDom(async ({ element, reports, dismiss }) => {
			const banner = setupErrorBanner(element);
			banner.show(
				new Error("Error invoking remote method 'team:stop': Error: Session not running."),
				'window.action',
				'alice',
			);
			await Promise.resolve();
			expect(element('error-message').textContent).toBe('Session not running.');
			expect(element('error').hidden).toBe(false);
			expect(reports).toEqual([
				{
					level: 'error',
					source: 'window.action',
					member: 'alice',
					text: 'Session not running.',
				},
			]);
			dismiss();
			expect(element('error').hidden).toBe(true);
			banner.display('Retained reason.');
			expect(element('error-message').textContent).toBe('Retained reason.');
			expect(reports).toHaveLength(1);
		});
		const renderer = await Bun.file(`${DESKTOP}/renderer.ts`).text();
		expect(renderer).not.toContain('Error invoking remote method');
	});
});

describe('the controls that throw work away ask first', () => {
	test('every dialog with a discard prompt guards its backdrop with it too', async () => {
		const offenders: string[] = [];
		for (const { file, text } of await rendererSources())
			if (
				text.includes("window.confirm('Discard") &&
				/dismissOnOutsideClick\(\w+\)/u.test(text)
			)
				offenders.push(file);
		expect(offenders).toEqual([]);
		const macros = await Bun.file(`${DESKTOP}/macros.ts`).text();
		expect(macros).toContain('dismissOnOutsideClick(dialog, canClose);');
	});

	test('operator Stop confirms before ending the shell; Hide does not', async () => {
		const pane = await Bun.file(`${DESKTOP}/operator-pane.ts`).text();
		const stopAt = pane.indexOf("stop.addEventListener('click'");
		const confirmAt = pane.indexOf("window.confirm('Stop the operator shell?", stopAt);
		expect(confirmAt).toBeGreaterThan(stopAt);
		expect(confirmAt).toBeLessThan(pane.indexOf('.operatorStop()', stopAt));
		expect(pane).toContain(
			"element('operator-hide').addEventListener('click', () => setOpen(false));",
		);
	});
});
