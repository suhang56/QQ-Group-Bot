# pm2 → Windows Service Alternatives — Research + PoC Plan

**Date**: 2026-05-03
**Author**: ops research, post-#166
**Status**: research / decision-pending

## Why this exists

Per `feedback_pm2_windows_unreliable_consider_alternatives.md` and post-incident audits this and prior sessions, Windows pm2 has accumulated reliability issues that don't surface on Linux:

1. **Orphan child on stop** — `pm2 stop` does not always kill the node child. Subsequent `pm2 start` reports "already running" or holds a stale SQLite WAL lock (per `feedback_pm2_stop_can_orphan_process_on_windows.md`).
2. **Child-tracking loss** — `pm2 list` reports `pid=0 / status=waiting` while the actual node process is alive (~100MB RSS). pm2 daemon loses pointer.
3. **Stdout buffer wedging** — bot module runs + DB writes succeed, but `pm2-out.log` shows no new entries (IPC buffer hold without flush).
4. **Restart-counter accumulation** — repeated abnormal cycles inflate restart count even after underlying bug fix; needs full `pm2 kill` daemon reset.
5. **Recurring this session**: SQLite I/O error from orphan + 9-restart loop on first start after merge — required `Stop-Process orphan + pm2 delete + pm2 start fresh` four times in one session (#162, #163, #165, #166 ship cycles).

These are *Windows-port* issues — pm2 is Linux-native and Windows is second-class. NapCat already runs as Desktop GUI (per user directive 04-28); only `qq-bot` itself remains under pm2.

## Decision dimensions

| Need | pm2 | nssm | sc.exe (native Windows Service) | Task Scheduler |
|---|---|---|---|---|
| Auto-restart on crash | ✓ | ✓ | ✓ (FailureActions) | ✗ (needs wrapper script) |
| Throttle: max-restarts in window | ✓ (10/60s) | ✓ throttle delay | partial | ✗ |
| max-memory-restart | ✓ (1500M) | ✗ | ✗ | ✗ |
| Auto-start on boot | ✓ (via pm2-startup) | ✓ (Service Auto) | ✓ (Service Auto) | ✓ (At Startup trigger) |
| Stdout/stderr → log file | ✓ | ✓ (AppStdout/Err) | needs wrapper (e.g. winsw, .bat) | ✓ |
| Native to Windows | ✗ | ✓ | ✓ | ✓ |
| Required external download | npm install | nssm-2.24.zip (1.5MB) | none | none |
| Service Manager UI integration | ✗ | ✓ (services.msc shows it) | ✓ | ✓ (Task Scheduler GUI) |
| Manageable via PowerShell `Get-Service` | ✗ | ✓ | ✓ | ✗ (uses schtasks) |
| Logs visible in Event Viewer | ✗ | ✓ | ✓ | ✓ |
| Maintenance overhead (this codebase) | high (many gotchas) | low | medium (wrapper code) | high (manual restart logic) |

### Quick recommendation

- **nssm** — best overall for our needs. Free OSS (BSD-style license), well-tested wrapper around Service Control Manager (SCM). Provides everything pm2 gives us minus `max_memory_restart`. Memory-restart can be replaced by an in-bot guard (RSS check + `process.exit(1)`) which is cleaner anyway.
- **sc.exe (native Service)** — requires a service-host wrapper because `node.exe` isn't a service binary. Either ship a small C# wrapper or use winsw.exe (which is essentially what nssm gives us). Reinventing nssm.
- **Task Scheduler** — no auto-restart on crash. Bot crashes during the day → silent until user notices. Disqualified for our HA requirement.

**Path forward**: nssm PoC. If smoke passes, switch from pm2 to nssm with documented migration.

## What pm2 features we currently use (from `ecosystem.config.cjs`)

```
script: dist/index.js
node_args: --experimental-sqlite
exec_mode: fork (single instance)
autorestart: true
max_restarts: 10
min_uptime: 60s
max_memory_restart: 1500M
restart_delay: 2000ms
output: D:/QQ-Group-Bot/logs/pm2-out.log
error: D:/QQ-Group-Bot/logs/pm2-err.log
env: NODE_ENV=production, LOG_LEVEL=debug, G_MESSAGES_DEBUG='', G_DEBUG=none
```

## Equivalent nssm setup (reference, not yet executed)

```
# After downloading nssm to ~/Downloads/nssm-2.24/win64/nssm.exe
nssm install qq-bot "C:\Program Files\nodejs\node.exe"
nssm set qq-bot AppParameters --experimental-sqlite dist\index.js
nssm set qq-bot AppDirectory D:\QQ-Group-Bot
nssm set qq-bot AppStdout D:\QQ-Group-Bot\logs\nssm-out.log
nssm set qq-bot AppStderr D:\QQ-Group-Bot\logs\nssm-err.log
nssm set qq-bot AppRotateFiles 1
nssm set qq-bot AppRotateBytes 10485760
nssm set qq-bot AppEnvironmentExtra NODE_ENV=production LOG_LEVEL=debug G_DEBUG=none G_MESSAGES_DEBUG=
nssm set qq-bot AppThrottle 60000        # restart-delay-throttle 60s
nssm set qq-bot AppExit Default Restart  # auto-restart on any exit
nssm set qq-bot AppRestartDelay 2000     # 2s before restart attempt
nssm set qq-bot Start SERVICE_AUTO_START # boot startup
nssm set qq-bot DisplayName "QQ Group Bot"
nssm set qq-bot Description "Node.js QQ group chatbot. Restart manages crashes."

# Start it
nssm start qq-bot
# or
sc start qq-bot

# Status
sc query qq-bot
# or
Get-Service qq-bot
```

## Migration plan (if PoC passes)

1. **Install nssm** as service `qq-bot-nssm` (different name from pm2 to allow side-by-side test)
2. **Smoke test** for 1-2 hours: stop pm2, start nssm-managed bot, verify:
   - Connects to NapCat ✓
   - Replies to messages ✓
   - Auto-restart on `Stop-Process` ✓
   - Logs flushing to nssm-out.log / nssm-err.log ✓
   - Boot startup works ✓ (test by Restart-Computer)
3. **Migrate** — rename service to `qq-bot`, remove pm2 config commit (keep ecosystem.config.cjs as historical)
4. **Document** — replace pm2 commands in CLAUDE.md, status update memory

## What about `max_memory_restart`?

pm2's `max_memory_restart: 1500M` watches RSS and restarts on overshoot. nssm has no equivalent. Two options:

**A. In-bot guard** (recommended)
```ts
// src/index.ts add at startup
const MAX_RSS_MB = 1500;
setInterval(() => {
  const rssMb = process.memoryUsage.rss() / 1024 / 1024;
  if (rssMb > MAX_RSS_MB) {
    logger.error({ rssMb, limit: MAX_RSS_MB }, 'memory limit exceeded — exiting for service restart');
    process.exit(1);
  }
}, 30000).unref?.();
```
Service auto-restart picks it up. Cleaner than pm2 sniffing externally. ~10 LOC. Honors `feedback_timer_unref.md`.

**B. Task Scheduler watchdog** running every 5 min, checks `Get-Process node | Select RSS` for our pid, restarts service if > 1500MB. More moving parts.

Choose A.

## Risks / open questions

1. **Service Account** — nssm by default runs as LocalSystem. Is that OK for accessing `D:/QQ-Group-Bot/data/bot.db` and writing logs? Likely yes (LocalSystem has full disk access), but should verify. Alternative: configure to run as current user account.
2. **NapCat WS connection** — bot connects to NapCat (Desktop GUI). When bot runs as service, can it still reach NapCat's local WS port? Should work (loopback localhost:port), but verify.
3. **Bot graceful shutdown** — pm2 sends SIGINT; service stop sends `STOP` control which Windows nssm translates to clean exit. Bot's #155 signal handlers handle SIGINT — does nssm's STOP→SIGTERM translation reach our Node handlers? Test.
4. **PowerShell vs bash CLI ergonomics** — `pm2 logs` is convenient; `Get-Content -Wait nssm-out.log` is the equivalent. Document the new commands clearly.

## PoC steps (when nssm available)

Per user authorization for PoC scope:

1. User downloads `nssm-2.24.zip` from https://nssm.cc/download → extracts to `~/Downloads/nssm-2.24`
2. Verify SHA256 (current 2.24 win64 nssm.exe sha256: published on nssm.cc)
3. Install as `qq-bot-nssm-poc` (NOT `qq-bot` to avoid name collision with pm2)
4. Run smoke list above
5. Capture findings in `docs/ops/pm2-vs-nssm-smoke-results.md`
6. User decides whether to migrate

## What this PoC does NOT cover

- NapCat replacement (already Desktop GUI per user)
- Bot code change (memory-restart guard goes in separate PR after PoC passes)
- Production migration (this is research; migration is a separate user-approved step)

## Decision request

User to choose:
- **(A)** Download nssm, run PoC → I document results + migration path
- **(B)** Skip PoC for now, keep this doc as roadmap
- **(C)** Try built-in Windows Service path (sc.exe + small wrapper) — more work, no external dep

Recommendation: **A**. nssm is well-known, free, OSS, reproducible smoke in 30 minutes, lowest-cost path to validate the whole approach. If smoke fails, no commitment to migrate.
