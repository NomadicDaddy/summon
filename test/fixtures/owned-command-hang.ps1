[System.IO.File]::WriteAllText($env:FIXTURE_READY, [string]$PID)
while ($true) { Start-Sleep -Seconds 1 }
