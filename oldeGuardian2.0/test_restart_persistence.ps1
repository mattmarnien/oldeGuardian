# Test script: start backend, capture state, restart backend, capture state again
# Usage: run from repository root (C:\Users\mgm21\code2.0\oldeGuardian)
# Requires PowerShell. Adjust paths if your environment differs.

$backendDir = Join-Path $PSScriptRoot 'backend'
$nodeCmd = 'node'
$backendEntry = Join-Path $backendDir 'index.js'
$port = 3001
$baseUrl = "http://localhost:$port"
$logPath = Join-Path $backendDir 'backend.log'

# Kill any process that is listening on the given TCP port (best-effort)
function Kill-PortProcess {
    param([int]$Port)
    try {
        if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
            $conns = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
            if ($conns) {
                $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
                foreach ($pid in $pids) {
                    try { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue } catch {}
                }
            }
        } else {
            # fallback to netstat parsing
            $lines = netstat -ano | Select-String ":$Port "
            foreach ($l in $lines) {
                $parts = ($l -split '\s+') | Where-Object { $_ -ne '' }
                $pid = $parts[-1]
                if ($pid -and ($pid -match '^\d+$')) {
                    try { Stop-Process -Id ([int]$pid) -Force -ErrorAction SilentlyContinue } catch {}
                }
            }
        }
    } catch {
        Write-Host "Kill-PortProcess failed: $_"
    }
    Start-Sleep -Milliseconds 300
}

function Start-Backend {
    Write-Host "Starting backend..."
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $nodeCmd
    $startInfo.Arguments = "`"$backendEntry`""
    $startInfo.WorkingDirectory = $backendDir
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $startInfo
    $p.Start() | Out-Null
    Start-Sleep -Milliseconds 600
    return $p
}

function Wait-ApiReady {
    param($timeoutSec = 20)
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
        $resp = Invoke-WebRequest -Uri ($baseUrl + '/api/state') -UseBasicParsing -Method GET -TimeoutSec 5 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) { return $true }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    return $false
}

function Save-ApiState($outfile) {
    try {
    $s = Invoke-RestMethod -Uri ($baseUrl + '/api/state') -Method GET -TimeoutSec 10
        $s | ConvertTo-Json -Depth 10 | Out-File -FilePath $outfile -Encoding utf8
        return $true
    } catch {
        Write-Host "Failed to fetch /api/state: $_"
        return $false
    }
}

## ensure no other backend is running on the port before we start
Kill-PortProcess -Port $port
# Start backend
$proc = Start-Backend
if (-not (Wait-ApiReady -timeoutSec 15)) {
    Write-Host "Backend did not become ready in time. Check logs at $logPath"
} else {
    Write-Host "Backend ready. Saving pre-restart state..."
    Save-ApiState (Join-Path $PSScriptRoot 'pre_restart_state.json') | Out-Null
}

# Graceful stop
if ($proc -and -not $proc.HasExited) {
    Write-Host "Stopping backend..."
    try { $proc.Kill(); } catch { }
    Start-Sleep -Milliseconds 800
}

# Give a moment for process to exit
Start-Sleep -Seconds 1

# Ensure previous instance is stopped and then start again
if ($proc -and -not $proc.HasExited) {
    try { $proc.Kill(); } catch {}
}
Start-Sleep -Milliseconds 400
Kill-PortProcess -Port $port
$proc2 = Start-Backend
if (-not (Wait-ApiReady -timeoutSec 15)) {
    Write-Host "Backend did not become ready after restart. Check logs at $logPath"
} else {
    Write-Host "Backend ready after restart. Saving post-restart state..."
    Save-ApiState (Join-Path $PSScriptRoot 'post_restart_state.json') | Out-Null
}

# Dump backend.log tail
try {
    if (Test-Path $logPath) {
    Get-Content $logPath -Tail 400 | Out-File -FilePath (Join-Path $PSScriptRoot 'post_restart_log_tail.txt') -Encoding utf8
    }
} catch {
    Write-Host "Failed to save log tail: $_"
}

Write-Host "Test script finished. Files saved under oldeGuardian2.0/ if available."
