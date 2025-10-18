<#
Automated restart/persistence test script.
Starts backend, issues /api/join and /api/play to create a nowPlaying entry,
waits, captures pre-restart /api/state, restarts backend, captures post-restart /api/state,
and saves backend.log tail.

Usage:
  .\test_restart_persistence_auto.ps1 -GuildId 491059674095943680 -ChannelId 491059674095943684 -Track "music\09 SciFi\Dark Zone.mp3"

Run from repository root (where this script resides in oldeGuardian2.0).
#>
param(
  [string] $GuildId = '491059674095943680',
  [string] $ChannelId = '491059674095943684',
  [string] $Track = 'music\09 SciFi\Dark Zone.mp3',
  [int] $Port = 3001,
  [int] $WaitBeforeSnapshotSec = 6,
  [bool] $UseTestTone = $true,
  [int] $TestToneDuration = 120
)

$scriptRoot = $PSScriptRoot
$backendDir = Join-Path $scriptRoot 'backend'
$nodeCmd = 'node'
$backendEntry = Join-Path $backendDir 'index.js'
$baseUrl = "http://localhost:$Port"
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
  $si = New-Object System.Diagnostics.ProcessStartInfo
  $si.FileName = $nodeCmd
  $si.Arguments = "`"$backendEntry`""
  $si.WorkingDirectory = $backendDir
  $si.RedirectStandardOutput = $true
  $si.RedirectStandardError = $true
  $si.UseShellExecute = $false
  $si.CreateNoWindow = $true
  # expose a test-only env var so the backend will allow test injection
  try {
    # Do not enable BACKEND_ALLOW_TEST_INJECT for this run — we want to validate the real join path
    # $si.EnvironmentVariables['BACKEND_ALLOW_TEST_INJECT'] = '1'
  } catch { }
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $si
  $p.Start() | Out-Null
  Start-Sleep -Milliseconds 600
  return $p
}

function Stop-Proc($p) {
  if ($p -and -not $p.HasExited) {
    try { $p.Kill(); } catch { }
    Start-Sleep -Milliseconds 800
  }
}

function Wait-ApiReady([int]$timeoutSec=20) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
  $resp = Invoke-WebRequest -Uri ($baseUrl + '/api/state') -UseBasicParsing -Method GET -TimeoutSec 5 -ErrorAction Stop
      if ($resp.StatusCode -eq 200) { return $true }
    } catch { Start-Sleep -Milliseconds 500 }
  }
  return $false
}

function Save-ApiState($outfile) {
  try {
    # use /api/last-saved (in-memory) for deterministic snapshots
    $s = Invoke-RestMethod -Uri ($baseUrl + '/api/last-saved') -Method GET -TimeoutSec 10
    $s | ConvertTo-Json -Depth 10 | Out-File -FilePath $outfile -Encoding utf8
    return $true
  } catch {
    Write-Host "Failed to fetch /api/last-saved: $_"
    return $false
  }
}

function Wait-ForNowPlaying([string]$guildId, [bool]$expectNonNull = $true, [int]$timeoutSec = 20) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      # check in-memory persisted state for deterministic result
      $s = Invoke-RestMethod -Uri ($baseUrl + '/api/last-saved') -Method GET -TimeoutSec 5
      $np = $null
      if ($s -and $s.state -and $s.state.nowPlaying) {
        $np = $s.state.nowPlaying.$guildId
      }
      if ($expectNonNull) {
        if ($np -ne $null) { return $true }
      } else {
        if ($np -eq $null) { return $true }
      }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Post-Json($path, $obj) {
  try {
    $url = $baseUrl + $path
    return Invoke-RestMethod -Uri $url -Method POST -ContentType 'application/json' -Body (ConvertTo-Json $obj -Depth 10) -TimeoutSec 10
  } catch {
    Write-Host "POST $path failed: $_"
    return $null
  }
}

function Ensure-Join([string]$guildId, [string]$channelId, [int]$attempts=5) {
  for ($i=1; $i -le $attempts; $i++) {
    Write-Host "Attempting join ($i/$attempts)..."
    $resp = Post-Json '/api/join' @{ guildId = $guildId; channel = $channelId }
    if ($resp -ne $null) {
      # wait up to 6s for in-memory state to show the connection
      $deadline = (Get-Date).AddSeconds(6)
      while ((Get-Date) -lt $deadline) {
        try {
          $s = Invoke-RestMethod -Uri ($baseUrl + '/api/last-saved') -Method GET -TimeoutSec 3 -ErrorAction Stop
          if ($s -and $s.state -and $s.state.connections -and $s.state.connections.$guildId) {
            Write-Host "Join confirmed in persisted state."
            return $true
          }
        } catch { }
        Start-Sleep -Milliseconds 500
      }
    }
    Start-Sleep -Seconds 1
  }
  Write-Host "Ensure-Join failed after $attempts attempts."
  return $false
}

# Start backend
Kill-PortProcess -Port $Port
$proc = Start-Backend
if (-not (Wait-ApiReady -timeoutSec 20)) {
  Write-Host "Backend did not become ready in time. Check logs at $logPath"
  Stop-Proc $proc
  exit 1
}
Write-Host "Backend ready. Running join/play flow..."

# Issue join (with retries)
if (-not (Ensure-Join $GuildId $ChannelId 5)) {
  Write-Host "Join did not succeed; attempting debug-inject to create persisted connection/nowPlaying"
  try {
    $inj = Post-Json '/api/debug-inject' @{ guildId = $GuildId; channelId = $ChannelId; track = $Track }
    if ($inj -and $inj.success) { Write-Host "debug-inject succeeded" } else { Write-Host "debug-inject failed or returned null" }
  } catch { Write-Host "debug-inject request failed: $_" }
}

# Issue play (fire-and-forget) or test-tone for longer playback
if ($UseTestTone) {
  $playResp = Post-Json '/api/test-tone' @{ guildId = $GuildId; channel = $ChannelId; duration = $TestToneDuration }
  Write-Host "test-tone response:"; $playResp | ConvertTo-Json -Depth 3
} else {
  $playResp = Post-Json '/api/play' @{ guildId = $GuildId; channel = $ChannelId; track = $Track }
  Write-Host "play response:"; $playResp | ConvertTo-Json -Depth 3
}

Write-Host "Waiting for nowPlaying to be set for guild $GuildId (timeout 60s)..."
if (-not (Wait-ForNowPlaying $GuildId $true 60)) {
  Write-Host "nowPlaying did not appear in time; capturing state anyway."
}
# Capture pre-restart state
$prePath = Join-Path $scriptRoot 'pre_restart_state.json'
Save-ApiState $prePath | Out-Null
Write-Host "Saved pre-restart state to $prePath"
try {
  if (Test-Path $logPath) {
    $lines = Get-Content $logPath -Raw -ErrorAction SilentlyContinue
    $matches = Select-String -InputObject $lines -Pattern 'debug-json base64:([A-Za-z0-9+/=]+)' -AllMatches
    if ($matches -and $matches.Matches.Count -gt 0) {
      $last = $matches.Matches[-1].Groups[1].Value
      $decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($last))
      $decoded | Out-File -FilePath (Join-Path $scriptRoot 'pre_debug.json') -Encoding utf8
      Write-Host "Saved decoded pre_debug.json"
    }
  }
} catch { Write-Host "Failed to extract pre debug: $_" }

# Restart backend
Write-Host "Restarting backend..."
Stop-Proc $proc
Start-Sleep -Seconds 1
$proc2 = Start-Backend
if (-not (Wait-ApiReady -timeoutSec 20)) {
  Write-Host "Backend did not become ready after restart. Check logs at $logPath"
  Stop-Proc $proc2
  exit 1
}
Write-Host "Waiting for nowPlaying to be restored after restart (timeout 60s)..."
if (-not (Wait-ForNowPlaying $GuildId $true 60)) {
  Write-Host "nowPlaying was not restored within timeout; capturing state anyway."
}
$postPath = Join-Path $scriptRoot 'post_restart_state.json'
Save-ApiState $postPath | Out-Null
Write-Host "Saved post-restart state to $postPath"
try {
  if (Test-Path $logPath) {
    $lines = Get-Content $logPath -Raw -ErrorAction SilentlyContinue
    $matches = Select-String -InputObject $lines -Pattern 'debug-json base64:([A-Za-z0-9+/=]+)' -AllMatches
    if ($matches -and $matches.Matches.Count -gt 0) {
      $last = $matches.Matches[-1].Groups[1].Value
      $decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($last))
      $decoded | Out-File -FilePath (Join-Path $scriptRoot 'post_debug.json') -Encoding utf8
      Write-Host "Saved decoded post_debug.json"
    }
  }
} catch { Write-Host "Failed to extract post debug: $_" }

# Save backend log tail
try {
  if (Test-Path $logPath) {
    Get-Content $logPath -Tail 400 | Out-File -FilePath (Join-Path $scriptRoot 'post_restart_log_tail.txt') -Encoding utf8
    Write-Host "Saved backend log tail"
  }
} catch { Write-Host "Failed to save log tail: $_" }

# Cleanup
Stop-Proc $proc2
Write-Host "Automated test finished. Files: pre_restart_state.json, post_restart_state.json, post_restart_log_tail.txt"
