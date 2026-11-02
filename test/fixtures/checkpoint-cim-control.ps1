param([Parameter(Mandatory)][string]$Query)
$ErrorActionPreference = 'Stop'
if ($env:SUMMON_TEST_OFFLINE -ne '1') { throw 'Disposable offline fixture required' }
function Get-CimInstance {
	param([string]$ClassName, [string]$Filter, [string]$ErrorAction)
	if ($ClassName -ne 'Win32_Process' -or $ErrorAction -ne 'Stop') { throw 'Unexpected query' }
	if ($Filter -ne "ProcessId = $PID") { return $null }
	switch ($env:SUMMON_TEST_CIM_CONTROL) {
		'matching' { return [pscustomobject]@{ ProcessId = $PID } }
		'missing' { return $null }
		'wrong' { return [pscustomobject]@{ ProcessId = $PID + 1 } }
		'error' { throw 'Fixture control unavailable' }
		default { throw 'Unknown fixture mode' }
	}
}
& ([scriptblock]::Create($Query))
