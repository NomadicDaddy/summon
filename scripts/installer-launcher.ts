import { runtimePrerequisites } from '../src/runtime-prerequisites.ts';

export function installerLauncher(build: string): string {
	if (!/^[a-z0-9.-]+$/i.test(build)) throw new Error('Invalid installer build ID.');
	const minimum = runtimePrerequisites[0]?.minimumVersion ?? '';
	if (!/^\d+\.\d+\.\d+$/.test(minimum)) throw new Error('Invalid Bun minimum version.');
	return [
		'@echo off',
		'setlocal DisableDelayedExpansion',
		`set "SUMMON_INSTALL_ROOT=%~dp0versions\\${build}"`,
		'set "SUMMON_BUN="',
		// One rule shared with setup's Dependencies page (installer/prerequisites.ps1): the first
		// bun.exe that exists, from PATH, then Bun's per-user folder, then winget's Links folder. Setup
		// applies it to the saved PATH a newly started program receives; this applies it to the PATH
		// this launcher inherited, which agree once the environment has been refreshed. The
		// folders cover a PATH that is not up to date yet right after setup. Nothing here runs a
		// candidate, so nothing here can hang; installed-launch.ts refuses one below the minimum.
		// Never the launcher's working folder or a bundled runtime. PATH is walked entry by entry
		// with setup's own policy: quotes removed, and only an entry that starts with a drive root
		// (X:\) or a UNC share (\\) is searched, so a relative entry is never resolved against any
		// folder (Morgan r2 M8, Roger r4).
		// Cleared first: setlocal keeps inherited variables, and an inherited SUMMON_PATH must never
		// stand in for an absent PATH (Morgan r5).
		'set "SUMMON_PATH="',
		'if defined PATH set "SUMMON_PATH=%PATH:"=%"',
		// Jumped over, not guarded with "if defined": CMD parses a whole line before evaluating it,
		// and this one is a syntax error when SUMMON_PATH is undefined (r11c measured exit 255).
		'if not defined SUMMON_PATH goto summon_path_walked',
		'for %%D in ("%SUMMON_PATH:;=" "%") do if not defined SUMMON_BUN (set "SUMMON_DIR=%%~D" & call :summon_path_entry)',
		':summon_path_walked',
		'if not defined SUMMON_BUN if exist "%USERPROFILE%\\.bun\\bin\\bun.exe" set "SUMMON_BUN=%USERPROFILE%\\.bun\\bin\\bun.exe"',
		'if not defined SUMMON_BUN if exist "%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\bun.exe" set "SUMMON_BUN=%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\bun.exe"',
		'if not defined SUMMON_BUN goto missing_bun',
		'set "PATH=%~dp0;%PATH%"',
		'"%SUMMON_BUN%" "%SUMMON_INSTALL_ROOT%\\app\\scripts\\installed-launch.ts" %*',
		'set "SUMMON_EXIT=%errorlevel%"',
		'if not "%SUMMON_EXIT%"=="0" goto launch_failed',
		'exit /b 0',
		':missing_bun',
		`echo Summon requires bun.exe from Bun ${minimum} or later on PATH before it can start. 1>&2`,
		`echo Install Bun from ${runtimePrerequisites[0]?.installUrl} 1>&2`,
		'echo After installation, open a new terminal or reopen Summon. 1>&2',
		'set "SUMMON_EXIT=1"',
		':launch_failed',
		// Start-menu cmd /c must leave prerequisite guidance visible on a failed Team Window launch.
		'if "%~1"=="--team" pause',
		'exit /b %SUMMON_EXIT%',
		// Sets SUMMON_BUN when SUMMON_DIR is a fully qualified folder holding a bun.exe file.
		':summon_path_entry',
		'if not defined SUMMON_DIR exit /b 0',
		'set "SUMMON_ROOT_DRIVE=%SUMMON_DIR:~1,2%"',
		'set "SUMMON_ROOT_UNC=%SUMMON_DIR:~0,2%"',
		'if not "%SUMMON_ROOT_DRIVE%"==":\\" if not "%SUMMON_ROOT_UNC%"=="\\\\" exit /b 0',
		'if exist "%SUMMON_DIR%\\bun.exe" if not exist "%SUMMON_DIR%\\bun.exe\\" set "SUMMON_BUN=%SUMMON_DIR%\\bun.exe"',
		'exit /b 0',
		'',
	].join('\r\n');
}
