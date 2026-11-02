# Summon installer helper: detect and install Bun and PowerShell 7 (installer-installs-runtime-prerequisites).
# Runs under the built-in Windows PowerShell 5.1, the only shell guaranteed on a clean Windows 11.
# Every result is written to -OutFile as key=value lines; the helper never fails Summon setup and
# never prints host paths. Location parameters default to this user's real folders; tests point them
# at fixtures so no test installs software, raises UAC, accepts agreements or changes PATH.
[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)][ValidateSet('detect', 'install')][string]$Mode,
	[ValidateSet('bun', 'pwsh')][string]$Id,
	[Parameter(Mandatory = $true)][string]$SourcesPath,
	[Parameter(Mandatory = $true)][string]$BunMinimum,
	[Parameter(Mandatory = $true)][string]$PwshMinimum,
	[Parameter(Mandatory = $true)][string]$OutFile,
	[string]$WingetPath = '',
	# The PATH a newly started Summon sees is the persisted machine PATH followed by the user PATH,
	# not this process's. '<registry>' reads the machine value; tests pass a fixture value instead.
	[string]$MachinePath = '<registry>',
	[string]$UserProfileRoot = $env:USERPROFILE,
	[string]$LocalAppDataRoot = $env:LOCALAPPDATA,
	# Where the user PATH lives: 'registry' (HKCU\Environment) or, in tests, a file of entries.
	[string]$PathStore = 'registry',
	# Every wait is bounded (spec clause 5): each probe, download read and the winget wait also stops
	# at the run's deadline. Local steps on the verified archive (hash, extract, copy, swap) start only
	# before it and are never interrupted, so they can finish after it; their work is bounded by the
	# archive, not their wall-clock time on slow storage.
	[int]$TotalTimeoutMs = 0,
	[int]$ProbeTimeoutMs = 15000,
	[int]$DownloadConnectTimeoutMs = 30000,
	[int]$DownloadStallTimeoutMs = 60000,
	[int]$WingetTimeoutMs = 1200000
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
# 5.1 writes progress records to a redirected stderr as CLIXML.
$ProgressPreference = 'SilentlyContinue'

if ($TotalTimeoutMs -le 0) { $TotalTimeoutMs = if ($Mode -eq 'detect') { 120000 } else { 1800000 } }
$Clock = [System.Diagnostics.Stopwatch]::StartNew()
function Get-RemainingMs {
	return [int][Math]::Max(0, $TotalTimeoutMs - $Clock.ElapsedMilliseconds)
}
function Get-BoundMs([int]$Limit) {
	return [int][Math]::Min($Limit, (Get-RemainingMs))
}

# winget codes after which no installer ran, so the pinned official ZIP may be tried (Bun only;
# PowerShell falls back only when winget is absent, Phillip D1 #26080). Every other code, and above
# all user cancellation and policy blocks, ends the attempt with no fallback (Morgan #26121).
# Values are the signed process exit codes from winget's returnCodes.md, so they compare exactly
# with Process.ExitCode.
$FallbackCodes = @(
	-1978335224, # 0x8A150008 DOWNLOAD_FAILED
	-1978335221, # 0x8A15000B SOURCES_INVALID
	-1978335217, # 0x8A15000F SOURCE_DATA_MISSING
	-1978335216, # 0x8A150010 NO_APPLICABLE_INSTALLER
	-1978335212, # 0x8A150014 NO_APPLICATIONS_FOUND
	-1978335211, # 0x8A150015 NO_SOURCES_DEFINED
	-1978335186, # 0x8A15002E DOWNLOAD_SIZE_MISMATCH
	-1978335169, # 0x8A15003F SOURCE_DATA_INTEGRITY_FAILURE
	-1978335163, # 0x8A150045 SOURCE_OPEN_FAILED
	-1978335157  # 0x8A15004B FAILED_TO_OPEN_ALL_SOURCES
)
# 0x8A15010C INSTALL_CANCELLED_BY_USER, 0x8A150077 AUTHENTICATION_CANCELLED_BY_USER
$CancelCodes = @(-1978334964, -1978335113)

function Format-Code([int]$Value) {
	return '0x{0:X8}' -f $Value
}

function Write-Result([hashtable]$Values) {
	$lines = foreach ($key in ($Values.Keys | Sort-Object)) {
		$text = [string]$Values[$key]
		# One line per key; the Pascal reader splits on the first '='.
		"$key=$($text -replace '[\r\n]+', ' ')"
	}
	[System.IO.File]::WriteAllLines($OutFile, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-StableVersion([string]$Text) {
	$match = [regex]::Match($Text.Trim(), '^(?:PowerShell )?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$')
	if (-not $match.Success) { return $null }
	return New-Object System.Version ([int]$match.Groups[1].Value), ([int]$match.Groups[2].Value), ([int]$match.Groups[3].Value)
}

# Runs `<exe> --version` as a native process, never through a shell.
function Invoke-VersionProbe([string]$Executable) {
	$info = New-Object System.Diagnostics.ProcessStartInfo
	$info.FileName = $Executable
	$info.Arguments = '--version'
	$info.UseShellExecute = $false
	$info.RedirectStandardOutput = $true
	$info.RedirectStandardError = $true
	$info.CreateNoWindow = $true
	$process = $null
	try {
		$process = [System.Diagnostics.Process]::Start($info)
		# Drain both streams asynchronously, so a full stderr pipe or a child that never closes stdout
		# cannot block before the timeout is applied.
		$stdout = $process.StandardOutput.ReadToEndAsync()
		$stderr = $process.StandardError.ReadToEndAsync()
		if (-not $process.WaitForExit((Get-BoundMs $ProbeTimeoutMs))) {
			try {
				$process.Kill()
				[void]$process.WaitForExit(2000)
			}
			catch { }
			return $null
		}
		if ($process.ExitCode -ne 0) { return $null }
		if (-not $stdout.Wait(2000)) { return $null }
		[void]$stderr.Wait(2000)
		return $stdout.Result
	}
	catch { return $null }
	finally {
		if ($process) { $process.Dispose() }
	}
}

# The persisted machine PATH, then the persisted user PATH: what a Summon started after setup sees.
function Get-PersistedPathEntries {
	$machine = $MachinePath
	if ($machine -eq '<registry>') {
		$key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment')
		$machine = if ($key) { [string]$key.GetValue('Path', '') } else { '' }
		if ($key) { $key.Close() }
	}
	$user = ''
	if ($PathStore -ne 'registry') {
		if (Test-Path -LiteralPath $PathStore) { $user = [System.IO.File]::ReadAllLines($PathStore) -join ';' }
	}
	else {
		$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
		$user = if ($key) { [string]$key.GetValue('Path', '') } else { '' }
		if ($key) { $key.Close() }
	}
	foreach ($entry in (($machine, $user) -join ';') -split ';') {
		[Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"'))
	}
}

# PATH directories that are fully qualified (C:\... or \\server\share\...), filtered before anything is
# joined or run. A relative or drive-relative entry would resolve against the working folder, which
# src/executable.ts already refuses (Morgan r1 High 3).
function Get-QualifiedPathDirectories {
	foreach ($entry in Get-PersistedPathEntries) {
		if ($entry -match '^[A-Za-z]:\\' -or $entry -match '^\\\\[^\\]+\\[^\\]+') { $entry }
	}
}

function Find-OnPath([string]$Name) {
	foreach ($directory in Get-QualifiedPathDirectories) {
		$path = Join-Path $directory $Name
		if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
	}
	return $null
}

# Candidates in the order Summon resolves them, the FIRST match on PATH first:
# - Bun: then Bun's per-user folder and winget's Links folder, exactly the installed launcher's
#   order (scripts/installer-launcher.ts), which looks in those folders itself.
# - PowerShell: PATH only. Summon resolves pwsh.exe through PATH alone (src/executable.ts), so a
#   copy in a folder that is not on PATH is one Summon cannot run (Roger/Morgan r2 High 2).
function Get-Candidates([string]$PrerequisiteId) {
	$name = "$PrerequisiteId.exe"
	$candidates = New-Object System.Collections.Generic.List[object]
	$onPath = Find-OnPath $name
	if ($onPath) { $candidates.Add(@{ path = $onPath; onPath = $true }) }
	if ($PrerequisiteId -eq 'bun') {
		foreach ($path in @((Join-Path $UserProfileRoot ".bun\bin\$name"), (Join-Path $LocalAppDataRoot "Microsoft\WinGet\Links\$name"))) {
			$candidates.Add(@{ path = $path; onPath = $false })
		}
	}
	return $candidates
}

# The state of the one copy a newly started Summon would run: the first that exists, as the launcher
# and Summon's executable lookup pick it from the saved PATH (a terminal opened before setup keeps
# its old PATH), so the page never calls a runtime found that such a Summon cannot start with, and never lets a later copy stand in for an earlier broken one (Roger r2 High 1).
# found: a stable version at or above the minimum; outdated: an older stable version; unreadable:
# its stable version cannot be read; missing: no copy at all. onPath says where that copy is.
function Get-PrerequisiteState([string]$PrerequisiteId) {
	$minimum = [System.Version]$(if ($PrerequisiteId -eq 'bun') { $BunMinimum } else { $PwshMinimum })
	foreach ($candidate in (Get-Candidates $PrerequisiteId)) {
		if (-not (Test-Path -LiteralPath $candidate.path -PathType Leaf)) { continue }
		$version = Get-StableVersion ([string](Invoke-VersionProbe $candidate.path))
		if ($null -eq $version) { return @{ status = 'unreadable'; version = ''; onPath = $candidate.onPath } }
		if ($version -ge $minimum) { return @{ status = 'found'; version = "$version"; onPath = $candidate.onPath } }
		return @{ status = 'outdated'; version = "$version"; onPath = $candidate.onPath }
	}
	return @{ status = 'missing'; version = ''; onPath = $false }
}

function Resolve-Winget {
	if ($WingetPath -eq 'none') { return $null }
	if ($WingetPath) {
		if (Test-Path -LiteralPath $WingetPath -PathType Leaf) { return $WingetPath }
		return $null
	}
	# The same fully qualified PATH search as the runtimes, never Get-Command's own resolution.
	return Find-OnPath 'winget.exe'
}

function Add-UserPathEntry([string]$Entry) {
	if ($PathStore -ne 'registry') {
		$existing = @()
		if (Test-Path -LiteralPath $PathStore) { $existing = [System.IO.File]::ReadAllLines($PathStore) }
		if ($existing -notcontains $Entry) {
			[System.IO.File]::WriteAllLines($PathStore, [string[]]($existing + $Entry), (New-Object System.Text.UTF8Encoding($false)))
		}
		return
	}
	# CreateSubKey opens the key for writing, creating it on a profile that lacks one.
	$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
	try {
		$raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
		$parts = @($raw -split ';' | Where-Object { $_ })
		foreach ($part in $parts) {
			if ($part.TrimEnd('\') -ieq $Entry.TrimEnd('\')) { return }
		}
		$key.SetValue('Path', (($parts + $Entry) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
	}
	finally { $key.Close() }
}

# Bounded download: a connect timeout, a stall timeout on every read, and the run's deadline over the
# whole transfer, so neither a silent server nor a slow trickle can hold setup (Roger r2 High 2).
function Save-Download([string]$Url, [string]$Path) {
	$request = [System.Net.HttpWebRequest]::Create($Url)
	$request.Timeout = Get-BoundMs $DownloadConnectTimeoutMs
	$request.ReadWriteTimeout = Get-BoundMs $DownloadStallTimeoutMs
	$response = $request.GetResponse()
	try {
		$stream = $response.GetResponseStream()
		$file = [System.IO.File]::Create($Path)
		try {
			$buffer = New-Object byte[] 65536
			while ($true) {
				# Each read may wait no longer than the stall limit or the time left in the run,
				# whichever is shorter, so no single read can outlast the deadline (Roger r3 #5).
				$bound = Get-BoundMs $DownloadStallTimeoutMs
				if ($bound -le 0) { throw 'The download did not finish in time.' }
				$stream.ReadTimeout = $bound
				$read = $stream.Read($buffer, 0, $buffer.Length)
				if ($read -le 0) { break }
				$file.Write($buffer, 0, $read)
			}
		}
		finally {
			$file.Close()
			$stream.Close()
		}
	}
	finally { $response.Close() }
}

# Hashing and extraction call .NET directly, never a module cmdlet, because Get-FileHash and
# Expand-Archive depend on module discovery. r10c's probe measured Get-FileHash as not found
# (command-not-found) in this helper under a shell whose PSModulePath listed PowerShell 7 folders
# first; why it was not found is unmeasured.
function Get-Sha256([string]$Path) {
	$sha = [System.Security.Cryptography.SHA256]::Create()
	try {
		$stream = [System.IO.File]::OpenRead($Path)
		try { $bytes = $sha.ComputeHash($stream) }
		finally { $stream.Dispose() }
	}
	finally { $sha.Dispose() }
	return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

function Install-Fallback([string]$PrerequisiteId, $Source) {
	$fallback = $Source.fallback
	$staging = Join-Path ([System.IO.Path]::GetTempPath()) ('summon-prerequisite-' + [guid]::NewGuid().ToString('N'))
	New-Item -ItemType Directory -Path $staging | Out-Null
	try {
		$archive = Join-Path $staging 'download.zip'
		[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
		try { Save-Download $fallback.url $archive }
		catch { return @{ outcome = 'failed'; detail = 'The official download could not be fetched, stalled or did not finish in time.' } }
		# Each local step starts only with time left in the run. A started step runs to completion; it
		# works on the pinned archive, so its length is bounded by that archive (Roger r3 #5).
		$late = @{ outcome = 'failed'; detail = 'Setup ran out of time before the official download could be installed; nothing was changed.' }
		if ((Get-RemainingMs) -le 0) { return $late }
		$actual = Get-Sha256 $archive
		if ($actual -ne $fallback.sha256) {
			# Checked before extraction: a mismatched archive is never unpacked or run.
			Remove-Item -LiteralPath $archive -Force
			return @{ outcome = 'failed'; detail = 'The official download did not match its pinned SHA256; nothing was installed.' }
		}
		if ((Get-RemainingMs) -le 0) { return $late }
		$expanded = Join-Path $staging 'expanded'
		# Loaded by its full name, inside the catch-all, with no cmdlet. .NET Framework 4.6.2 and later
		# refuse an entry that would land outside $expanded.
		[void][System.Reflection.Assembly]::Load('System.IO.Compression.FileSystem, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
		[System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $expanded)
		$executable = Join-Path $expanded ($fallback.executable -replace '/', '\')
		if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
			return @{ outcome = 'failed'; detail = 'The verified archive did not contain the expected executable.' }
		}
		if ((Get-RemainingMs) -le 0) { return $late }
		$kept = ''
		if ($PrerequisiteId -eq 'bun') {
			$target = Join-Path $UserProfileRoot '.bun\bin'
			New-Item -ItemType Directory -Path $target -Force | Out-Null
			$existing = Join-Path $target 'bun.exe'
			# The new copy is staged complete beside the active name first, so a failed copy never
			# touches the working bun.exe (Morgan r2 M4, Roger r3 #2). A staged file left by an
			# earlier attempt is not overwritten.
			$staged = Join-Path $target 'bun.exe.summon-new'
			# Checked before copying, so only a file that was already there is blamed on an earlier
			# attempt (Roger r5 Low). It is named so the user can clear it, never removed here.
			if (Test-Path -LiteralPath $staged) {
				return @{ outcome = 'failed'; detail = "A file named bun.exe.summon-new from an earlier attempt is in %USERPROFILE%\.bun\bin; delete it and run setup again. The current bun.exe was left unchanged." }
			}
			try { [System.IO.File]::Copy($executable, $staged, $false) }
			catch {
				# This attempt's own partial copy is removed.
				Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
				return @{ outcome = 'failed'; detail = 'The new Bun could not be staged beside the current one; the current bun.exe was left unchanged.' }
			}
			if (Test-Path -LiteralPath $existing -PathType Leaf) {
				# An older bun.exe is kept beside the new one, never overwritten (Morticia r1 L-2).
				$kept = "bun.exe.before-summon-$(Get-Date -Format 'yyyyMMddHHmmss')"
				try { [System.IO.File]::Move($existing, (Join-Path $target $kept)) }
				catch {
					Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
					return @{ outcome = 'failed'; detail = 'The current bun.exe could not be moved aside; it was left unchanged.' }
				}
			}
			try { [System.IO.File]::Move($staged, $existing) }
			catch {
				Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
				if (-not $kept) { return @{ outcome = 'failed'; detail = 'The new Bun could not be put in place; nothing was changed.' } }
				# Put the previous copy back under its active name so other consumers keep a Bun.
				try { [System.IO.File]::Move((Join-Path $target $kept), $existing) }
				catch {
					return @{ outcome = 'failed'; detail = "The new Bun could not be put in place and the previous copy could not be restored. Recover %USERPROFILE%\.bun\bin\$kept as bun.exe before retrying." }
				}
				return @{ outcome = 'failed'; detail = 'The new Bun could not be put in place; the previous bun.exe was restored.' }
			}
		}
		else {
			$target = Join-Path $LocalAppDataRoot ('Programs\PowerShell\' + $fallback.version)
			$displayTarget = "%LOCALAPPDATA%\Programs\PowerShell\$($fallback.version)"
			if (Test-Path -LiteralPath $target) {
				return @{ outcome = 'failed'; detail = "$displayTarget already exists and was left unchanged. Inspect it and move it aside before running setup again." }
			}
			$parent = Split-Path -Parent $target
			New-Item -ItemType Directory -Path $parent -Force | Out-Null
			$pending = Join-Path $parent ('.summon-new-' + [guid]::NewGuid().ToString('N'))
			$publishFailure = $null
			try {
				New-Item -ItemType Directory -Path $pending | Out-Null
				Copy-Item -Path (Join-Path $expanded '*') -Destination $pending -Recurse -Force
				# Same-volume rename publishes a complete tree and refuses a concurrently created target.
				[System.IO.Directory]::Move($pending, $target)
			}
			catch {
				$publishFailure = @{ outcome = 'failed'; detail = "PowerShell could not be staged or published at $displayTarget. Any existing version folder was left unchanged; free disk space or release file locks and retry setup." }
			}
			finally {
				if (Test-Path -LiteralPath $pending) {
					try { Remove-Item -LiteralPath $pending -Recurse -Force }
					catch {
						$name = Split-Path -Leaf $pending
						$publishFailure = @{ outcome = 'failed'; detail = "PowerShell staging failed and could not be cleaned up. Remove %LOCALAPPDATA%\Programs\PowerShell\$name after releasing file locks, then retry. The version folder was not replaced." }
					}
				}
			}
			if ($publishFailure) { return $publishFailure }
		}
		Add-UserPathEntry $target
		$detail = "Installed the pinned official $($fallback.version) release."
		if ($kept) { $detail = "$detail The previous copy was kept beside it as $kept." }
		return @{ outcome = 'installed'; detail = $detail }
	}
	finally {
		Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
	}
}

function Install-Prerequisite([string]$PrerequisiteId) {
	$sources = Get-Content -LiteralPath $SourcesPath -Raw | ConvertFrom-Json
	$source = $sources.$PrerequisiteId
	$winget = Resolve-Winget
	$result = $null
	if ($winget) {
		$arguments = @(
			'install', '--id', $source.winget, '--exact', '--source', 'winget', '--scope', $source.wingetScope,
			'--silent', '--disable-interactivity', '--accept-package-agreements', '--accept-source-agreements'
		)
		# PowerShell 7.6 defaults to MSIX; the consented machine-wide route requires its MSI.
		$typeProperty = $source.PSObject.Properties['wingetInstallerType']
		if ($typeProperty) { $arguments += @('--installer-type', [string]$typeProperty.Value) }
		$process = Start-Process -FilePath $winget -ArgumentList $arguments -PassThru -WindowStyle Hidden
		# Reading Handle first makes 5.1 keep the exit code after a timed WaitForExit.
		$null = $process.Handle
		if (-not $process.WaitForExit((Get-BoundMs $WingetTimeoutMs))) {
			# An installer may be mid-way, so it is left to finish rather than killed, and the result is
			# reported as unfinished, never as a failed or completed install (Roger r2).
			return @{ outcome = 'unfinished'; route = 'winget'; code = ''; detail = 'winget had not finished when setup stopped waiting and may still be running; no other source was tried.' }
		}
		$code = [int]$process.ExitCode
		if ($code -eq 0) {
			$result = @{ outcome = 'installed'; route = 'winget'; code = '0x00000000'; detail = "Installed $($source.winget) with winget." }
		}
		elseif ($CancelCodes -contains $code) {
			return @{ outcome = 'cancelled'; route = 'winget'; code = (Format-Code $process.ExitCode); detail = 'The installation was cancelled; no other source was tried.' }
		}
		elseif ($PrerequisiteId -eq 'bun' -and $FallbackCodes -contains $code) {
			$result = Install-Fallback $PrerequisiteId $source
			$result.route = 'fallback'
			$result.code = Format-Code $process.ExitCode
		}
		else {
			return @{ outcome = 'failed'; route = 'winget'; code = (Format-Code $process.ExitCode); detail = 'winget could not install it; no other source was tried.' }
		}
	}
	else {
		$result = Install-Fallback $PrerequisiteId $source
		$result.route = 'fallback'
		$result.code = ''
	}
	if ($result.outcome -eq 'installed') {
		# Report what Summon will actually run now, never the attempt alone.
		$state = Get-PrerequisiteState $PrerequisiteId
		if ($state.status -ne 'found') {
			$result.outcome = 'unverified'
			$cause = if ($state.onPath) { 'an earlier copy on PATH, which Summon uses first, is still' } else { 'the copy Summon would use is' }
			$result.detail = "$($result.detail) But $cause $($state.status); update or remove that copy."
		}
		$result.version = $state.version
	}
	return $result
}

try {
	if ($Mode -eq 'detect') {
		$bun = Get-PrerequisiteState 'bun'
		$pwsh = Get-PrerequisiteState 'pwsh'
		Write-Result @{
			'bun.status' = $bun.status; 'bun.version' = $bun.version; 'bun.onpath' = [int][bool]$bun.onPath
			'pwsh.status' = $pwsh.status; 'pwsh.version' = $pwsh.version; 'pwsh.onpath' = [int][bool]$pwsh.onPath
			'winget' = [int][bool](Resolve-Winget)
		}
	}
	else {
		if (-not $Id) { throw 'Install mode needs -Id.' }
		$result = Install-Prerequisite $Id
		$values = @{ 'id' = $Id }
		foreach ($key in @('outcome', 'route', 'code', 'detail', 'version')) {
			$values[$key] = if ($result.ContainsKey($key)) { $result[$key] } else { '' }
		}
		Write-Result $values
	}
}
catch {
	# Any helper failure is reported, never raised: Summon setup always completes. The error key holds
	# only the numeric HRESULT, the helper line and a label from a fixed list, so no message, error
	# ID, path or environment text can reach it (Morgan r10). Every read is guarded, so building it
	# cannot throw inside this catch (Morticia r10).
	# A failing .NET call arrives wrapped (method-invocation), so the inner exception's HRESULT and
	# label are reported too, guarded the same way; 'none' when there is no inner one (Morticia r10b).
	$known = @{
		'System.Management.Automation.RuntimeException' = 'runtime'
		'System.Management.Automation.PropertyNotFoundException' = 'property-not-found'
		'System.Management.Automation.MethodInvocationException' = 'method-invocation'
		'System.Management.Automation.ParameterBindingException' = 'parameter-binding'
		'System.Management.Automation.CommandNotFoundException' = 'command-not-found'
		'System.Management.Automation.ItemNotFoundException' = 'item-not-found'
		'System.IO.IOException' = 'io'
		'System.IO.FileNotFoundException' = 'file-not-found'
		'System.IO.DirectoryNotFoundException' = 'directory-not-found'
		'System.IO.InvalidDataException' = 'invalid-data'
		'System.UnauthorizedAccessException' = 'access-denied'
		'System.Net.WebException' = 'web'
		'System.InvalidOperationException' = 'invalid-operation'
		'System.NotSupportedException' = 'not-supported'
		'System.ObjectDisposedException' = 'object-disposed'
		'System.NullReferenceException' = 'null-reference'
		'System.FormatException' = 'format'
		'System.ArgumentException' = 'argument'
	}
	$hresult = 0
	$label = 'other'
	$innerHresult = 0
	$innerLabel = 'none'
	$line = 'unknown'
	if ($_.Exception) {
		$hresult = $_.Exception.HResult
		$type = $_.Exception.GetType().FullName
		if ($known.ContainsKey($type)) { $label = $known[$type] }
		$inner = $_.Exception.InnerException
		if ($inner) {
			$innerHresult = $inner.HResult
			$innerType = $inner.GetType().FullName
			$innerLabel = if ($known.ContainsKey($innerType)) { $known[$innerType] } else { 'other' }
		}
	}
	if ($_.InvocationInfo -and $_.InvocationInfo.ScriptLineNumber -gt 0) { $line = [string]$_.InvocationInfo.ScriptLineNumber }
	$failure = 'hresult 0x{0:X8} line {1} {2} inner 0x{3:X8} {4}' -f $hresult, $line, $label, $innerHresult, $innerLabel
	if ($Mode -eq 'detect') {
		Write-Result @{ 'bun.status' = 'unknown'; 'bun.version' = ''; 'bun.onpath' = 0; 'pwsh.status' = 'unknown'; 'pwsh.version' = ''; 'pwsh.onpath' = 0; 'winget' = 0; 'error' = $failure }
	}
	else {
		Write-Result @{ 'id' = $Id; 'outcome' = 'failed'; 'route' = ''; 'code' = ''; 'detail' = 'The prerequisite helper stopped unexpectedly.'; 'version' = ''; 'error' = $failure }
	}
}
exit 0
