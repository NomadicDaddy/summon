param([string]$CommandFile, [string]$Scenario)
$ErrorActionPreference = 'Stop'
function Get-CimInstance {
    if ($Scenario -ne 'missing-control') {
        [pscustomobject]@{ ProcessId = $PID; CreationDate = [datetime]::UtcNow; ExecutablePath = 'fixture.exe'; Name = 'pwsh.exe'; CommandLine = 'fixture' }
    }
    if ($Scenario -eq 'session') {
        [pscustomobject]@{ ProcessId = 123; Name = 'bun.exe'; CommandLine = 'bun cli.ts __session alpha'; CreationDate = [datetime]::UtcNow; ExecutablePath = 'bun.exe' }
    }
    if ($Scenario -eq 'window') {
        [pscustomobject]@{ ProcessId = 456; Name = 'electron.exe'; CommandLine = 'electron.exe D:\app\dist\team\main.mjs'; CreationDate = [datetime]::UtcNow; ExecutablePath = 'electron.exe' }
    }
    if ($Scenario -eq 'unknown') {
        [pscustomobject]@{ ProcessId = 789; Name = 'bun.exe'; CommandLine = $null; CreationDate = [datetime]::UtcNow; ExecutablePath = 'bun.exe' }
    }
}
& ([scriptblock]::Create((Get-Content -LiteralPath $CommandFile -Raw -Encoding utf8)))
