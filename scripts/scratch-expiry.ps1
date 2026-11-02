#Requires -Version 7.6
<#
.SYNOPSIS
Expire old files in one store's scratch tree through held, checked handles.
.DESCRIPTION
Private worker for summon's operator startup. Input is one bounded JSON line with the scratch
root, the cutoff in FILETIME ticks and whether test pauses are on. Output is one JSON line per
step: ready (with present, absent or redirected), then, only after the parent answers 'start',
any pause points and the report. The pipe
carries relative paths and counts, never file contents. Failure releases every handle.
#>
[CmdletBinding()]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Private JSON pipe protocol requires Console, not a host or pipeline formatter.')]
param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$expiry = $null
try {
    if (-not $IsWindows) { throw 'Windows is required.' }
    $line = [Console]::ReadLine()
    if ($null -eq $line -or $line.Length -gt 65536) { throw 'Invalid expiry input.' }
    $request = $line | ConvertFrom-Json
    if ($request.cutoff -notmatch '^\d{1,19}$') { throw 'Invalid expiry cutoff.' }
    Add-Type -Path (Join-Path $PSScriptRoot 'scratch-expiry.cs')
    $expiry = [ScratchExpiry]::new([long]$request.cutoff)
    if ($request.pause -eq $true) {
        $expiry.Pause = [Func[string, string, bool]] {
            param($point, $path)
            [Console]::WriteLine((@{ pause = $point; path = $path } | ConvertTo-Json -Compress -EscapeHandling EscapeNonAscii))
            [Console]::ReadLine() -eq 'continue'
        }
    }
    $state = $expiry.Hold([string]$request.root)
    [Console]::WriteLine((@{ ready = $true; state = $state } | ConvertTo-Json -Compress -EscapeHandling EscapeNonAscii))
    if ($state -eq 'present') {
        # Nothing is deleted until the parent has accepted ready and sent exactly 'start'.
        # EOF or any other line ends here, and finally releases every handle.
        if ([Console]::ReadLine() -ne 'start') { throw 'Expiry start was not acknowledged.' }
        $expiry.Run()
    }
    [Console]::WriteLine((@{ report = $expiry.Report() } | ConvertTo-Json -Depth 4 -Compress -EscapeHandling EscapeNonAscii))
}
catch {
    $failure = $_.Exception.GetBaseException()
    $failureCode = if ($failure -is [ComponentModel.Win32Exception]) { $failure.NativeErrorCode } else { $failure.HResult }
    $failureType = $failure.GetType().Name
    $stage = if ($null -ne $expiry) { $expiry.Stage } else { 'startup' }
    [Console]::Error.WriteLine("Scratch expiry stopped ($failureType/$failureCode/$stage).")
    exit 1
}
finally {
    if ($null -ne $expiry) { $expiry.Dispose() }
}
