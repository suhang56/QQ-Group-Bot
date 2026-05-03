# nssm Runbook — QQ-Group-Bot

**As of**: 2026-05-03
**Service name**: `qq-bot`
**Replaces**: pm2 (retired per `docs/ops/pm2-vs-nssm-smoke-results.md`)

## Service config

```
DisplayName : QQ Group Bot
StartType   : Automatic (boot startup)
Wrapper     : C:\Users\WaterMelon\Downloads\nssm-2.24\nssm-2.24\win64\nssm.exe
Binary      : C:\Program Files\nodejs\node.exe --experimental-sqlite D:\QQ-Group-Bot\dist\index.js
Cwd         : D:\QQ-Group-Bot
Stdout      : D:\QQ-Group-Bot\logs\nssm-out.log (rotate at 10 MB)
Stderr      : D:\QQ-Group-Bot\logs\nssm-err.log (rotate at 10 MB)
RestartDelay: 2000 ms
Throttle    : 60000 ms (suppress fast restart loops)
Env         : NODE_ENV=production, LOG_LEVEL=debug, G_MESSAGES_DEBUG='', G_DEBUG=none, BOT_MAX_RSS_MB=1500
```

## Daily ops

```powershell
# at-a-glance
Get-Service qq-bot

# start / stop / restart
Start-Service qq-bot
Stop-Service qq-bot
Restart-Service qq-bot   # equivalent: Stop + Start

# live log tail (PowerShell)
Get-Content D:\QQ-Group-Bot\logs\nssm-out.log -Wait -Tail 50

# stderr (errors / GLib warnings)
Get-Content D:\QQ-Group-Bot\logs\nssm-err.log -Wait -Tail 50

# inspect node child + RSS
$svcPid = (Get-WmiObject Win32_Service -Filter "Name='qq-bot'").ProcessId
$child  = Get-CimInstance Win32_Process -Filter "ParentProcessId=$svcPid AND Name='node.exe'" | Select-Object -First 1
$proc   = Get-Process -Id $child.ProcessId
"$($child.ProcessId)  RSS=$([math]::Round($proc.WorkingSet64 / 1024 / 1024)) MB"
```

## Memory restart

In-bot `rss-guard.ts` (#168) checks RSS every 30s; when over `BOT_MAX_RSS_MB` (default 1500 MB) it logs structured error and exits with code 1. nssm sees abnormal exit → AppExit Default Restart triggers respawn after AppRestartDelay 2 s.

To override threshold:
```
nssm set qq-bot AppEnvironmentExtra "NODE_ENV=production" "LOG_LEVEL=debug" "G_MESSAGES_DEBUG=" "G_DEBUG=none" "BOT_MAX_RSS_MB=2000"
Restart-Service qq-bot
```

To disable the guard:
```
nssm set qq-bot AppEnvironmentExtra "NODE_ENV=production" ... "BOT_MAX_RSS_MB=0"
```

## Crash debugging

1. Check service status: `Get-Service qq-bot`
2. If status `Paused` momentarily — nssm in restart-throttle window (5-60 s); wait
3. If `Stopped` and won't restart — check stderr for fatal error:
   ```powershell
   Get-Content D:\QQ-Group-Bot\logs\nssm-err.log -Tail 100
   ```
4. Manual restart attempt: `Start-Service qq-bot`
5. If repeated rapid restarts → underlying bug. Look at `(Get-Service qq-bot).Status` plus stdout last 500 lines.

## Reinstalling / updating service config

```powershell
# Stop + remove
$nssm = "C:\Users\WaterMelon\Downloads\nssm-2.24\nssm-2.24\win64\nssm.exe"
Stop-Service qq-bot
& $nssm remove qq-bot confirm

# Reinstall (paste the full install block from docs/ops/pm2-alternatives-research.md)
& $nssm install qq-bot "C:\Program Files\nodejs\node.exe" "--experimental-sqlite D:\QQ-Group-Bot\dist\index.js"
& $nssm set qq-bot AppDirectory D:\QQ-Group-Bot
& $nssm set qq-bot AppStdout D:\QQ-Group-Bot\logs\nssm-out.log
& $nssm set qq-bot AppStderr D:\QQ-Group-Bot\logs\nssm-err.log
& $nssm set qq-bot AppRotateFiles 1
& $nssm set qq-bot AppRotateBytes 10485760
& $nssm set qq-bot AppExit Default Restart
& $nssm set qq-bot AppRestartDelay 2000
& $nssm set qq-bot AppThrottle 60000
& $nssm set qq-bot AppEnvironmentExtra NODE_ENV=production LOG_LEVEL=debug G_MESSAGES_DEBUG= G_DEBUG=none BOT_MAX_RSS_MB=1500
& $nssm set qq-bot Start SERVICE_AUTO_START
& $nssm set qq-bot DisplayName "QQ Group Bot"
Start-Service qq-bot
```

## After-build deploy step

```powershell
# 1. tsc rebuild
cd D:\QQ-Group-Bot
npm run build

# 2. restart service to pick up new dist/
Restart-Service qq-bot

# 3. verify
Get-Content D:\QQ-Group-Bot\logs\nssm-out.log -Tail 30
```

## Migration history

- 2026-05-03 a1a43f5 (#168) — RSS guard ships in-bot
- 2026-05-03 (this runbook) — pm2 retired, nssm service `qq-bot` installed
- pm2 stays installed for legacy helpers (e.g. NapCat in earlier setups, but currently NapCat = Desktop GUI; pm2 daemon is essentially idle)

## Related docs

- `docs/ops/pm2-alternatives-research.md` — comparison + decision rationale
- `docs/ops/pm2-vs-nssm-smoke-results.md` — PoC smoke evidence
- `feedback_pm2_windows_unreliable_consider_alternatives.md` — root cause history (memory)
