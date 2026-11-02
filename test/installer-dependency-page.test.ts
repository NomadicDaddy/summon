import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// The Pascal layer cannot run under bun test; these pin the contract the rebuilt installer's
// clean-host run (F5) then measures. All logic lives in installer/prerequisites.ps1.
const script = await readFile(resolve(import.meta.dir, '../installer/summon.iss'), 'utf8');

test('the installer refuses to compile without the minimums and pinned versions', () => {
	for (const define of ['BunMinimum', 'PwshMinimum', 'BunFallbackVersion', 'PwshFallbackVersion'])
		expect(script).toContain(`#ifndef ${define}\n  #error Build with bun run build:installer.`);
	// Bun and PowerShell versions come from runtime-prerequisites.ts or the pinned manifest only.
	expect(script).not.toMatch(/\b1\.4\.\d+\b|\b7\.\d+\.\d+\b/);
});

test('the helper and pinned manifest ride in setup only, never in the installed files', () => {
	expect(script).toContain('Source: "prerequisites.ps1"; Flags: dontcopy');
	expect(script).toContain('Source: "prerequisite-sources.json"; Flags: dontcopy');
	expect(script).not.toMatch(/prerequisites\.ps1"; DestDir/);
});

test('the Dependencies page links the applicable terms and announces UAC before consent', () => {
	expect(script).toContain("CreateInputOptionPage(wpSelectDir, 'Dependencies'");
	expect(script).toContain('Windows will show a UAC prompt for it');
	for (const link of [
		'https://github.com/oven-sh/bun/blob/bun-v{#BunFallbackVersion}/LICENSE.md',
		'https://github.com/PowerShell/PowerShell/blob/v{#PwshFallbackVersion}/LICENSE.txt',
		'https://github.com/microsoft/winget-pkgs',
	])
		expect(script).toContain(`<a href="${link}">`);
	expect(script).toContain('Terms := TNewLinkLabel.Create(DependencyPage);');
	expect(script).toContain('Terms.OnLinkClick := @TermsLinkClick;');
	expect(script).toContain('winget checks its own package hash');
	expect(script).toContain("ItemEnabled[0] := BunStatus <> 'found'");
	expect(script).toContain("ItemEnabled[1] := PwshStatus <> 'found'");
});

test('a silent install runs no detection, downloads or elevation; dependencies follow Summon’s files', () => {
	expect(script).toMatch(
		/procedure InitializeWizard\(\);\s+begin\s+\/\/[^\n]*\n\s+if WizardSilent\(\) then exit;\s+DetectDependencies\(\);/,
	);
	expect(script).toContain('if WizardSilent() or (DependencyPage = nil) then exit;');
	expect(script).toMatch(/InstallDependencies\(\);\s+try\s+UpdateUserPath\(True\);\s+except/);
	expect(script).toContain('PATH was not updated; start Summon from Start.');
	// The helper is run, never raised through: no RaiseException in the dependency path.
	const dependencyCode = script.slice(
		script.indexOf('function ReadHelperValue'),
		script.indexOf('function RuntimeIsRunning'),
	);
	expect(dependencyCode).not.toContain('RaiseException');
});

test('upgrades append uninstall logs rather than sweeping unknown version contents', () => {
	expect(script).toContain('UninstallLogMode=append');
	expect(script).not.toContain('DelTree(');
	expect(script).toContain('RootAttributes and FILE_ATTRIBUTE_REPARSE_POINT <> 0 then exit');
});

test('PATH editing preserves types and avoids writes when nothing changes', () => {
	expect(script).toContain('if not Changed then exit;');
	expect(script).toContain("RegDeleteValue(HKCU, 'Environment', 'Path')");
	expect(script).toContain("RegWriteStringValue(HKCU, 'Environment', 'Path', NewPath)");
	expect(script).not.toContain('RegWriteExpandStringValue(');
	expect(script).toContain('Part := Copy(Part, 2, Length(Part) - 2);');
});

test('orphan cleanup and PATH errors do not abort the logged uninstall', () => {
	expect(script).toMatch(/RemoveInterruptedSetupFiles\(Directory, ScanSubdirs\);\s+except/);
	expect(script).toMatch(/UpdateUserPath\(False\);\s+except/);
	expect(script).toContain("(CurUninstallStep = usDone) and (UninstallReport <> '')");
});

test('finished guidance is keyboard-accessible and scrollable instead of clipped label text', () => {
	expect(script).toContain('FinishedDetails.ReadOnly := True;');
	expect(script).toContain('FinishedDetails.ScrollBars := ssVertical;');
	expect(script).toContain('FinishedDetails.Text :=');
});
