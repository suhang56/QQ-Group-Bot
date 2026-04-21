# Feature: fix/phrase-miner-skip-bot-output

## Why

Log evidence (struggle-log.md 2026-04-20/21, Cat 7):
- `log:4112/4204/4432/5589` — phrase-miner captured `再@我你试试` × 5 from bot's own output
- `log:2659` — catalogued bot-produced `女的22岁` + `烦死了` as jargon → entered `meme_graph` → prompt feedback loop

`feedback_learner_read_path_filter_for_historical_contamination` pattern: persist-filter blocks future
writes; read-path filter skips existing contaminated rows (no DB migration). Write-time: aggressive (drop
before insert); purge: ultra-conservative (宁漏不错 — false-positive erases user data).

## Scope IN

1. **Write-time filter (aggressive)** — 4 learner modules, before any DB insert:
   - `src/modules/phrase-miner.ts`
   - `src/modules/jargon-miner.ts`
   - `src/modules/meme-clusterer.ts`
   - `src/modules/self-learning.ts` — only at sub-pipelines that already have a source field

2. **Read-path filter** — wherever learned phrases are formatted for prompt injection, skip rows
   where source_user_id (or equivalent) equals botUserId (no DB mutation, pure skip at read time)

3. **Purge script** — `scripts/maintenance/purge-bot-output-phrases.ts`
   - Default dry-run; `--apply` triggers UPDATE; marks `status='rejected'` (no physical DELETE)
   - Only touches tables with precise bot-source field (source_user_id / sender_id / is_from_bot)
   - Tables lacking precise source field → skipped + logged "skipped: <table>"
   - CLI: `--db-path <path> [--apply] [--verbose]` (mirrors purge-emotive-facts.ts #107)

4. **Tests** — vitest, scoped to touched files:
   - User message enters miner pipeline ✓
   - Bot message at write-time: 0 DB inserts
   - Bot message at read-time: existing bot-source row absent from prompt block
   - Purge fixture: bot-source rows → rejected; user-source rows unchanged; no-source tables → skipped

## Scope OUT

- Send-guard chain (PR1 / PR2 / PR4)
- Behavior tuning (R2.5.1+, PR5–7)
- FTS5 / embedding learning pipelines
- Tone / tsundere / escalation logic
- Any new regex or content filter beyond bot-source identity check

## Must-NOT-fire (≥ 6 cases)

1. **User message normal flow** — userId ≠ botUserId → write proceeds as before; read path returns row
2. **Bot message skip** — skip = return before pipeline (not write-then-reject; never touches DB)
3. **No source field on table** — purge script skips table entirely, logs "skipped: <table_name>"; no guesses
4. **botUserId not configured** — write filter is no-op (undefined === row.userId is false); purge exits with warning, no changes
5. **Row has null/missing source metadata** — treated as non-bot (conservative); neither filtered at write nor purged
6. **User-authored phrase later quoted by bot** — only bot's own origination rows are source-flagged; a user phrase read from DB is not bot-originated
7. **FTS5 sync after reject** — purge script does NOT touch FTS5 shadow tables; Designer to specify if manual FTS rebuild needed post-apply

## Acceptance

- `tsc` clean (× 2 passes)
- `vitest` full suite: all existing 3914 baseline pass + new tests
- Write path: inject synthetic bot message → `SELECT COUNT(*)` on all source-trackable learner tables = 0 new rows
- Purge dry-run: logs "would update N" on bot-source fixture rows, "skipped: X" for tables without precise field
- Purge --apply: bot-source fixture rows = `status='rejected'`; user-source rows status unchanged
- No regression on replay tags: `sticker-token-leak` / `hard-gate-blocked` / `direct-at-silenced-by-timing` / `silence_defer_compliance`

## Open Questions for Designer

1. **Schema grep** — which learner tables have a precise bot-source field?
   Look for: `source_user_id`, `sender_id`, `is_from_bot`, `user_id` with foreign key to users table.
   Tables of interest: `meme_graph`, `jargon`, `phrase_cache` (or whatever phrase-miner writes to),
   `self_learning_*`. Report column name + type per table, or "no precise field" for skip.

2. **self-learning.ts sub-pipelines** — how many sub-pipelines exist, and which already carry a
   source/user field at insertion point? Need names so Developer knows which to filter vs skip.

3. **Read-path locations** — where are learned phrases formatted for prompt injection?
   (e.g. `formatPhrasesForPrompt` / `getMemeContext` etc.) — need all call sites for read-filter.

4. **Purge CLI additions needed?** — should `--group-id` scope be supported (per-group purge),
   or is global purge sufficient for this PR?

5. **FTS5 trigger** — after `status='rejected'`, does any FTS5 shadow table need manual rebuild,
   or does the trigger handle it? Designer check `schema.sql` for `CREATE TRIGGER` on status column.
