#Requires -Version 7.6
<# .SYNOPSIS
Exercise short paths and in-place junction conversion only in disposable retention fixtures.
#>
[CmdletBinding(SupportsShouldProcess)]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Private JSON fixture pipe protocol.')]
param(
    [Parameter(Mandatory)][ValidateSet('short', 'reparse')][string]$Mode,
    [Parameter(Mandatory)][string]$TestRoot,
    [Parameter(Mandatory)][string]$Path,
    [string]$Target
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$fixtureRoot = [IO.Path]::GetFullPath($TestRoot)
if ([IO.Path]::GetDirectoryName($fixtureRoot) -ne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -or
    [IO.Path]::GetFileName($fixtureRoot) -notlike 'summon-retention-*') { throw 'Wrong fixture root.' }
foreach ($candidate in @($Path, $Target) | Where-Object { $_ }) {
    if (-not [IO.Path]::GetFullPath($candidate).StartsWith($fixtureRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Path escaped disposable fixture.'
    }
}
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class RetentionFixturePaths {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetShortPathNameW(string path, StringBuilder result, uint length);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DeviceIoControl(SafeFileHandle file, uint code, byte[] input, int length,
        IntPtr output, int outputLength, out int returned, IntPtr overlapped);
    public static string Short(string path) {
        var output = new StringBuilder(32768);
        uint count = GetShortPathNameW(path, output, (uint)output.Capacity);
        if (count == 0 || count >= output.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
        return output.ToString();
    }
    public static void Reparse(string path, string target) {
        byte[] substitute = Encoding.Unicode.GetBytes("\\??\\" + target);
        byte[] printed = Encoding.Unicode.GetBytes(target);
        var buffer = new byte[16 + substitute.Length + 2 + printed.Length + 2];
        BitConverter.GetBytes(0xA0000003u).CopyTo(buffer, 0);
        BitConverter.GetBytes((ushort)(buffer.Length - 8)).CopyTo(buffer, 4);
        BitConverter.GetBytes((ushort)substitute.Length).CopyTo(buffer, 10);
        BitConverter.GetBytes((ushort)(substitute.Length + 2)).CopyTo(buffer, 12);
        BitConverter.GetBytes((ushort)printed.Length).CopyTo(buffer, 14);
        substitute.CopyTo(buffer, 16);
        printed.CopyTo(buffer, 18 + substitute.Length);
        using var handle = CreateFileW(path, 0x40000000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (handle.IsInvalid || !DeviceIoControl(handle, 0x900A4, buffer, buffer.Length,
            IntPtr.Zero, 0, out _, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@
if ($Mode -eq 'short') {
    @{ path = [RetentionFixturePaths]::Short($Path) } | ConvertTo-Json -Compress
}
elseif ($PSCmdlet.ShouldProcess($Path, 'Convert disposable empty directory to fixture junction')) {
    [RetentionFixturePaths]::Reparse($Path, $Target)
    @{ converted = $true } | ConvertTo-Json -Compress
}
