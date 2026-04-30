# R7 Metrics Baseline + Dashboard Runbook

**Last updated**: 2026-04-30 post-PR #156. Master HEAD `32638b5`.

This page is the runbook for the eval infrastructure shipped 2026-04-30 (#152–#156). Read it before adding R4.5 / R9 / behavior PRs. The dashboard isn't a UI — it's a set of CLI scripts + curated baseline numbers + decision rules.

## TL;DR — current baseline

| Metric | Mock 1027 | Real LLM 781 | Take |
|---|---|---|---|
| direct-at-silenced | **10.9%** | **4.5%** | mock over-states 60%; **real is the truth** |
| direct-at-silenced-by-guard | 6.1% | 1.0% | ↓84% on real |
| direct-at-silenced-by-abuse | 4.4% | 2.8% | ↓36% on real |
| gold-silent-but-replied | 0.4% | 0.4% | flat |
| gold-defer-but-replied | 0% | 0.13% | +1 (real LLM noise) |
| fact-needed-no-fact | (mock blind) | 2.0% (16) | post-#153 expected ↓ |
| sticker-when-not-allowed | 0 | 0.6% (5) | new visibility |
| hard-gate-blocked | 0 | 0.6% (5) | new visibility |

**Source files** (all gitignored locally):
- `data/eval/gold/gold-1027.jsonl` — gold labels (493 pre-existing + 528 auto + 6 human-resolved this session)
- `data/eval/gold/benchmark-merged-1027.jsonl` — 8-batch merged benchmark
- `data/eval/replay/real-merged-781/replay-output.jsonl` — last real-LLM run (76% coverage; remaining 246 need re-run after #155 stability fix)
- `data/eval/replay/master-postroadmap-dirty-e87eb7e-*.json` — mock baseline snapshot

## Eval CLIs (post-#152/#155)

### 1. Mock benchmark replay (fast, deterministic, CI-safe)

```bash
npx tsx scripts/eval/replay-runner.ts \
  --gold data/eval/gold/gold-1027.jsonl \
  --benchmark data/eval/gold/benchmark-merged-1027.jsonl \
  --output /tmp/mock-run.jsonl \
  --llm-mode=mock \
  --prod-db data/bot.db --bot-qq 1705075399 --group-id 958751334 \
  --timeout-ms 10000
```
- **Cost**: $0
- **Time**: ~10s for 1027 rows
- **Use when**: testing gate behavior changes (silent/defer/reply, scope-claim, timing); CI / pre-merge regression
- **Limitation**: cannot test prompt content, persona tone, fact retrieval correctness, post-LLM guards (mock returns `[mock:hash] 好的`)

### 2. Real-LLM benchmark replay (slow, costed, prompt-quality truth)

```bash
GEMINI_API_KEY=$(grep GEMINI_API_KEY .env | cut -d= -f2) \
npx tsx scripts/eval/replay-runner.ts \
  --gold data/eval/gold/gold-1027.jsonl \
  --benchmark data/eval/gold/benchmark-merged-1027.jsonl \
  --output /tmp/real-run.jsonl \
  --llm-mode=real --max-cost-usd 5.00 --rps 1 \
  --prod-db data/bot.db --bot-qq 1705075399 --group-id 958751334 \
  --timeout-ms 30000
```
- **Cost**: ~$0.4-1.0 per 1027-row run (Gemini 2.5 Flash $0.075/M input + $0.30/M output)
- **Time**: ~17-30 min wall-clock at rps=1 (Gemini free-tier 60 RPM ceiling)
- **Use when**: validating prompt/persona/fact-retrieval changes; post-major-PR sanity; quarterly regression
- **Stability** (post-#155): keepAlive event-loop pin + signal handlers (SIGTERM/SIGHUP/SIGINT) + atomic JSONL writes + checkpoint summary every 50 rows. Background mode now reliable. If process killed mid-run, partial output + halted summary recoverable.
- **Cost cap behavior**: pre-row check + in-call check; halts gracefully with `summary.json halted=true haltReason='cost-cap'`.

### 3. Resume partial runs

When a real-LLM run hits 429/cost-cap/signal mid-flight:
```bash
# 1. Identify processed IDs from partial output
npx tsx scripts/eval/filter-remaining-gold.ts \
  --gold data/eval/gold/gold-1027.jsonl \
  --benchmark data/eval/gold/benchmark-merged-1027.jsonl \
  --partial /tmp/real-run.jsonl/replay-output.jsonl \
  --gold-out /tmp/remaining.gold.jsonl \
  --bench-out /tmp/remaining.bench.jsonl

# 2. Re-run on remaining
npx tsx scripts/eval/replay-runner.ts \
  --gold /tmp/remaining.gold.jsonl --benchmark /tmp/remaining.bench.jsonl \
  --output /tmp/resume.jsonl --llm-mode=real --rps 1 \
  --prod-db data/bot.db --bot-qq 1705075399 --group-id 958751334

# 3. Dedupe-merge into final dataset
npx tsx scripts/eval/dedupe-replay.ts \
  /tmp/real-run.jsonl/replay-output.jsonl /tmp/resume.jsonl/replay-output.jsonl \
  --out /tmp/merged-final/replay-output.jsonl
```

### 4. Aggregate + compare

```bash
# Aggregate single run
npx tsx scripts/eval/aggregate-metrics.ts /tmp/merged-final/replay-output.jsonl > /tmp/aggregate.json

# Compare 2 snapshots
npx tsx scripts/eval/compare-metrics.ts \
  data/eval/snapshots/master-baseline.json /tmp/post-fix.json \
  --no-fail-on-regression --full-tags
```

### 5. Snapshot recorder (R7.4)

```bash
npx tsx scripts/eval/snapshot.ts \
  --gold data/eval/gold/gold-1027.jsonl \
  --benchmark data/eval/gold/benchmark-merged-1027.jsonl \
  --prod-db data/bot.db --bot-qq 1705075399 --group-id 958751334 \
  --label master-postX --output-dir data/eval/snapshots \
  --llm-mode mock --timeout-ms 10000
```
Use after every major PR merge for trend tracking. `--llm-mode=real` snapshots are non-deterministic (5–10% drift between reruns) — annotate the `realLlm:true` flag in summary so consumers know.

### 6. Eval-PR wrapper (R7.3, easy mode)

```bash
npx tsx scripts/eval/eval-pr.ts --gold ... --benchmark ... --baseline ... --candidate ...
# Single CLI: replay → aggregate → compare → markdown table
```

## Alias regression set (#156)

Built once, regenerate when learned_facts table changes:
```bash
npx tsx scripts/eval/build-alias-regression-set.ts
# Output: data/eval/alias-retrieval-regression.jsonl (gitignored)
```
Current state: 28 samples / 37 alias facts / 4 prompt-kinds. Top: Kisa(7) / jt(7) / ygfn(5) / 小叮当 / yu3 / 王喆.

**Use case**: regression-test PR #153 (fact-retrieval-alias-gap) by replaying these queries through real-LLM runner and asserting `matchedFactRetrievalIds` includes `expected_fact_id`. Add CI integration when a future PR could regress alias retrieval.

## Attribution kit pattern (#154)

When merging multiple behavior PRs in one batch, write attribution analysis 48–72h post-merge:
1. Define window: `2026-04-28 14:14 → 2026-04-29 14:14 ET` (48h post-first-PR-of-batch)
2. Query `chat_decision_events` filtered by reasonCode per PR contract
3. Query `group_config` for any feature flag PRs
4. Verdict table: ✅ working as designed / ⚪ no fire (validate via grep src/) / ❌ regression
5. Write `docs/eval/attribution-window-YYYY-MM-DD.md` with filled numbers
6. Open PR with `chore(eval):` prefix

Per `feedback_remote_vs_local_execution_choice.md`: run locally when DB access available; remote agent only for async wait scenarios.

## Decision tree — when something looks bad

| Situation | First action |
|---|---|
| Mock run shows direct-at-silenced > 5% | Run real-LLM 100-row sample → if real shows < 2%, mock artifact, ignore mock |
| Real-LLM shows fact-needed-no-fact > 1% | Inspect rows via `inspect-rows.ts` → likely alias retrieval or BM25 short-token gap |
| direct-at-silenced-by-guard > 1% on real | Check guard chain: sticker / harassment / persona / scope-claim — often false-positive on legit content |
| sticker-when-not-allowed > 1% | Real bot picking sticker reply when gold says text — investigate sticker-first router (#135 S1 capture related) |
| target-mismatch fires | R2b `_pickBestTarget` regression check; usually thread continuity ranker tuning needed |
| meta-status-misclassified > 0.5% | R4-lite act classifier missing patterns; widen `bot-referent` regex |
| Real-LLM run silent-exits | Should be impossible post-#155; if happens, check summary.json `haltReason` field. If no summary at all, verify `keepAlive` setInterval hasn't been removed |

## Use-case ↔ tool mapping

| I want to | Use |
|---|---|
| Pre-merge sanity check on input classifier / scope guard / timing gate change | Mock replay |
| Post-merge sanity on prompt/persona/fact retrieval change | Real-LLM replay |
| Spot-check 5 specific rows | Real-LLM replay with `--limit 5` and curated benchmark subset |
| Compare two PRs | Snapshot both → compare-metrics |
| Regression-test alias retrieval | alias-retrieval-regression.jsonl + real-LLM replay + assert matchedFactRetrievalIds |
| Attribute behavior shift after batch merge | Attribution kit pattern (#154 example) |
| Inspect specific row triggers + context | `scripts/eval/inspect-rows.ts <id1> <id2> ...` |

## Roadmap status (2026-04-30)

- ✅ R6 gold-1027 (gold extension + auto-curate scripts shipped)
- ✅ R7.1–R7.4 metrics infra (aggregate / compare / eval-pr / snapshot — pre-session)
- ✅ R7 real-LLM mode (#152) + stability (#155)
- ✅ Fact-retrieval alias gap (#153) — validates against regression set (#156)
- ✅ Attribution kit pattern (#154 as exemplar)
- ⏸ **R5 v2 canary** — flag `chat_prompt_layering_v2` default false; eligible to flip on 1 group from 2026-05-11 (R5 #127 + 14d)
- ⏸ **R4.5 LLM shadow classifier** — utterance_act classifier with 4 gates (一致率 ≥85% / 分布合理 / cost ≤5x rule-based / p99 ≤800ms); infrastructure from #152 reusable
- ⏸ **R9 Planner/replyer-lite** (MUCA replyer style) — offline-wins-baseline-then-real-group cadence
- ⏸ **R8 legacy cleanup** — gated on R5 canary stable 2+ weeks; delete `_getGroupIdentityPrompt` / `expression_patterns` table

## Behavior-layer next decision: R4.5 vs R9

**Defer until current observation window closes** (~05-03 = 72h post-#155 ship). Then decide based on which gap real-LLM benchmark surfaces more strongly:

- If `meta-status-misclassified` / `target-mismatch` / `bot-status-act-accuracy` show drift → R4.5 LLM shadow classifier (proves LLM > rule-based for utterance_act)
- If `fact-needed-no-fact` persists post-#153 / `repeated-low-info-direct-overreply` rises / replyer tone diverges from group voice → R9 Planner/replyer-lite (separates planning from replying, MUCA-style)

Don't pick speculatively. Run real-LLM benchmark + look at top violations, choose the layer with biggest signal.

## Maintenance

- **Worktree-local files** (gitignored): `data/eval/gold/*.jsonl`, `data/eval/replay/*`, `data/eval/snapshots/*`. Rebuild via scripts when needed.
- **Long sessions clean OS Temp** per `feedback_temp_dir_cleanup_after_long_sessions.md`: vitest leaks `test.db*` and replay-runner leaves `replay-*.db` in `%TEMP%`. Clean before C: < 5 GB.
- **Cost discipline**: real-LLM runs cap at $5 by default. Don't disable cap for full 1027 unless explicitly authorized — a misconfig (rps=20, retry=10) can burn through quickly.
