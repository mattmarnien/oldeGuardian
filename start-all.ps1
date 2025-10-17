# start-all.ps1
# Starts backend and frontend in new PowerShell windows from the repository root.

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

$backendDir = Join-Path $scriptDir 'oldeGuardian2.0\backend'
$frontendDir = Join-Path $scriptDir 'oldeGuardian2.0\frontend'

Write-Host "Starting backend in new window (dir: $backendDir)"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$backendDir'; npm run dev" -WindowStyle Normal

Start-Sleep -Seconds 1

Write-Host "Starting frontend in new window (dir: $frontendDir)"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$frontendDir'; npm start" -WindowStyle Normal

Write-Host "Both processes launched. Close the windows to stop them."
