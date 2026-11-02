#Requires -Version 7.6
<#
.SYNOPSIS
Hold plain retention paths against replacement until the caller closes stdin.
.DESCRIPTION
Private read-only worker. Input is one bounded JSON line containing paths, then
one observation request after the caller authorizes held canonical locations.
The private pipe carries metadata and the authorized pin input, never message
bodies. Unexpected input or access fails closed. EOF/failure releases handles.
#>
[CmdletBinding()]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Private JSON pipe protocol requires Console, not a host or pipeline formatter.')]
param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$guard = $null
try {
    if (-not $IsWindows) { throw 'Windows is required.' }
    $line = [Console]::ReadLine()
    if ($null -eq $line -or $line.Length -gt 262144) { throw 'Invalid guard input.' }
    $request = $line | ConvertFrom-Json
    $paths = @($request.paths)
    if ($paths.Count -lt 1 -or $paths.Count -gt 16) { throw 'Invalid path count.' }
    Add-Type -Path @((Join-Path $PSScriptRoot 'retention-path-guard.cs'), (Join-Path $PSScriptRoot 'retention-handle-io.cs'))
    $guard = [RetentionPathGuard]::new()
    $present = @($paths | ForEach-Object { $guard.Hold([string]$_) })
    $canonical = [object[]]::new($paths.Count)
    for ($index = 0; $index -lt $paths.Count; $index++) { $canonical[$index] = $guard.Canonical([string]$paths[$index]) }
    [Console]::WriteLine((@{ ready = $true; present = $present; canonical = $canonical } | ConvertTo-Json -Compress))
    $command = [Console]::ReadLine()
    if ($command -ne 'release') {
        $operation = $command | ConvertFrom-Json
        if ($paths.Count -notin 5, 6 -or $operation.offset -lt 0 -or $operation.offset -gt 20000) {
            throw 'Invalid observation request.'
        }
        $pins = if ($paths.Count -eq 6) { [string]$paths[5] } else { $null }
        $result = $guard.Observe([string]$paths[0], [bool[]]$present, $pins, [int]$operation.offset)
        [Console]::WriteLine(($result | ConvertTo-Json -Depth 6 -Compress))
        $command = [Console]::ReadLine()
    }
    # The caller owns this short-lived worker. EOF always releases the handles.
    if ($command -ne 'release') { throw 'Invalid guard release.' }
}
catch {
    $failure = $_.Exception.GetBaseException()
    $failureCode = if ($failure -is [ComponentModel.Win32Exception]) { $failure.NativeErrorCode } else { $failure.HResult }
    $failureType = $failure.GetType().Name
    $stage = if ($null -ne $guard) { $guard.Stage } else { 'startup' }
    [Console]::Error.WriteLine("Retention path guard refused access ($failureType/$failureCode/$stage); no inventory was accepted.")
    exit 1
}
finally {
    if ($null -ne $guard) { $guard.Dispose() }
}
