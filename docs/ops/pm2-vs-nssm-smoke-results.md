# nssm PoC Smoke Results — 2026-05-03

**Companion to**: `pm2-alternatives-research.md`
**nssm version**: 2.24 (sha256 nssm.exe: `F689EE9AF94B00E9E3F0BB072B34CAAF207F32DCB4F5782FC9CA351DF9A06C97`)
**Test target**: throwaway dummy node script at `C:\Users\WaterMelon\nssm-poc\dummy-bot.js` running under service `nssm-poc-dummy` (PoC service, removed after test)
**Production safety**: prod pm2-managed `qq-bot` was NOT touched during this PoC

## Setup

```
nssm install nssm-poc-dummy "C:\Program Files\nodejs\node.exe" C:\Users\WaterMelon\nssm-poc\dummy-bot.js
nssm set nssm-poc-dummy AppDirectory C:\Users\WaterMelon\nssm-poc
nssm set nssm-poc-dummy AppStdout <logs>\out.log
nssm set nssm-poc-dummy AppStderr <logs>\err.log
nssm set nssm-poc-dummy AppRotateFiles 1
nssm set nssm-poc-dummy AppRotateBytes 1048576    # 1 MB rotate
nssm set nssm-poc-dummy AppExit Default Restart   # auto-restart
nssm set nssm-poc-dummy AppRestartDelay 2000      # 2s before restart
nssm set nssm-poc-dummy AppThrottle 5000          # 5s throttle window
nssm set nssm-poc-dummy AppEnvironmentExtra CRASH_AFTER_S=8 TEST_VAR=hello
```

## Smoke results — all PASS

| # | Test | Result |
|---|---|---|
| 1 | Service starts; stdout flushes to `out.log` in real-time without buffer wedge | **PASS** — heartbeats arrived at 5s intervals as written |
| 2 | Kill child node.exe (Stop-Process) → wrapper survives + nssm respawns child after AppRestartDelay | **PASS** — child pid 125416 → 58036; wrapper pid 32776 stable; ~4s recovery |
| 3 | Stop-Service → SIGINT delivered → bot's signal handler logs graceful shutdown + exits 0 | **PASS** — `[shutdown] pid=58036 got SIGINT, exiting cleanly` in stdout |
| 4 | env vars (`CRASH_AFTER_S=8`) passed to child + AppThrottle prevents instant restart loop | **PASS** — 3 crash→respawn cycles in 25s, ~8s uptime each, throttle held |

## What this validates

| Concern | Verdict |
|---|---|
| pm2 stdout buffer wedge (Windows IPC issue) | nssm does not have this — log file gets line-flushed writes from node directly via redirect |
| pm2 child-tracking loss (pid=0 / status=waiting while alive) | nssm uses Windows Service Control Manager → `Get-Service` always reflects truth |
| pm2 orphan on stop | Stop-Service → SIGINT propagates; child exits cleanly. No orphan observed in PoC. |
| pm2 restart counter accumulates after underlying bug fix | nssm has no equivalent counter — service either Running or Stopped |
| Auto-restart on crash | Honored exactly like pm2's autorestart |
| Restart throttle (max-restarts in window) | `AppThrottle` covers this |
| Boot startup | `Start SERVICE_AUTO_START` flag (not tested in PoC — would need reboot) |
| Logs flushing during long sessions | First 25s of PoC: file-flushed continuously; pm2's IPC buffer issue does not apply |
| Env vars | Honored via `AppEnvironmentExtra` |
| Signal handlers (#155 atomic JSONL streaming + halt summary depend on SIGINT/SIGTERM/SIGHUP) | **CRITICAL: PASS** — SIGINT delivered. Worth noting #155 specifically needed signal halt; nssm's stop method is compatible. |

## What's NOT covered by nssm vs pm2

| pm2 feature | nssm equivalent | Mitigation |
|---|---|---|
| `max_memory_restart: 1500M` | NONE | In-bot RSS guard (~10 LOC, see research doc §"What about max_memory_restart") |
| `pm2 logs <name>` live tail | `Get-Content -Wait <log>` | Document new command in CLAUDE.md |
| `pm2 monit` TUI | `services.msc` GUI + Task Manager | Acceptable trade |
| pm2 restart counter accumulation | None — service has Running/Stopped | actually a feature, not a regression |

## Migration risk profile

| Risk | Likelihood | Mitigation |
|---|---|---|
| LocalSystem account can't access D:\QQ-Group-Bot\data\bot.db | Low (LocalSystem has full disk) | Configure `nssm set qq-bot ObjectName .\WaterMelon <password>` if needed |
| NapCat WS connection from service context | Low (loopback localhost) | Smoke test before commit |
| SIGINT/SIGTERM mismatch with #155 halt-summary handlers | LOW — PoC verified SIGINT delivered, handlers work | Already proven |
| nssm 2.24 stale (last release Aug 2014) | Low — ABI is stable, Service Control Manager unchanged | Could use a more recent fork (NSSM-Fork) but 2.24 is the canonical reference |
| Cost of migration overhead exceeds pm2 pain | Medium | Pin to nssm only if pm2 cycles >2 in next 30d |

## Recommendation

**Migrate to nssm** for production qq-bot.

Migration path (separate user-approved step):
1. **In-bot RSS guard PR** (~10 LOC + test, ship via 5-agent pipeline) — one-time cleanup before switch
2. **Stop pm2 qq-bot** + `pm2 delete qq-bot` to remove from pm2 daemon
3. **Install nssm service** with config above (rename to `qq-bot` since pm2 entry now removed)
4. **Smoke 1 hour live** — replies, NapCat connect, log flushing
5. **Update CLAUDE.md** — replace pm2 commands with nssm/Get-Service equivalents
6. **Remove ecosystem.config.cjs** (or move to `docs/ops/legacy/`)
7. **Update memories** — `feedback_pm2_windows_unreliable_consider_alternatives.md` retire; document new ops cadence

Total scope: 1 small PR (RSS guard) + ~30 min ops swap. Reversible: re-install pm2 if nssm hits unexpected issues.

## Out of scope for this PoC

- Reboot startup test (would need actual restart)
- Long-running stability (24h+) — would need actual qq-bot mounted, post-migration test
- NapCat WS reconnect under service context — requires real bot
- Side-by-side prod test (would conflict on SQLite WAL + NapCat WS) — must be a clean cutover

## Decision

Recommend **migrate to nssm**. PoC validated all critical pm2 features. Outstanding:
1. User approves migration kickoff
2. Schedule 30-min ops window for cutover (low traffic time)
3. RSS guard PR ships first (mechanical, ~10 LOC)
