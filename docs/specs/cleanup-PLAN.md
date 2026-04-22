# Feature: legacy-classifier-junk purge

## Why
Post-R2.5.1 audit found 3 junk row classes in `learned_facts`:
1. `opus-ext-classified:*` — 467 active rows, no writer since batch job retired, no runtime reader, absent from `LEARNED_FACT_TOPIC_PREFIXES` whitelist.
2. `source_user_nickname LIKE '[harvest:%'` rows — batch harvest artefacts, no functional reader (`[harvest:]` appears in router.ts only as a stats label in a COUNT query, not a fact-read path).
3. `opus-classified:slang` duplicates — 8 rows with dedup noise (`yes`, `周六`) and natural-language variants (`NB`/`nb`, `哦耶`/`欧耶`).
User directive: reject-only (no DELETE), dry-run first, alias-miner rows untouched.

## Scope IN
1. New script `scripts/maintenance/purge-legacy-classifier-junk.ts` — single CLI, three sub-commands (`--target 1|2|3|all`).
2. **Target 1** SQL filter: `topic LIKE 'opus-ext-classified:%' AND status='active'` — reject all ~467 rows.
3. **Target 2** SQL filter: `(source_user_nickname LIKE '[harvest:%' OR source_user_nickname LIKE '[deep-tune:%') AND status='active'` — reject ~900–1000 rows; skip any row where `topic LIKE '%群友别名%'` (alias-miner double-safety).
4. **Target 3** `opus-classified:slang` dedup — group by lowercase+Han-normalized key; keep winner per group by: (a) more natural Chinese / common casing; (b) `occurrence_count` DESC; (c) `speaker_count` DESC; (d) `id` DESC tiebreaker. Noise list `['yes','周六']` → reject regardless of dedup winner.
5. Tests: dry-run assertion per target + `--apply` UPDATE count matches dry-run + alias-miner rows (`topic LIKE '群友别名%'`) count unchanged before/after.
6. Output summary: per-target `{ rejected, skipped, keptDuplicateWinner }` — format TBD by Designer.

## Scope OUT
- No changes to runtime behavior, prompt assembly, or any module besides the new script.
- `opus-rest-classified:*` (2339 rows, mostly pending) — not touched; reader status unverified.
- Social-phrase variants (`宝宝们 / ohno宝宝`) within `opus-ext-classified:slang` — handled by existing purge-social-phrase-facts.ts; not re-targeted here.
- `user-taught:*`, `群内黑话:*`, lore-topic rows — permanent exemption.
- Schema changes, new columns, FTS5 trigger modifications — none.

## Pre-PR reader grep (results)

```
rg "\[harvest:|\[deep-tune:" src/
```
**NON-EMPTY** — 2 hits:
- `src/core/router.ts:2808` — stats-only COUNT label (`nick.startsWith('[harvest:')? 'harvest'`), NOT a DB fact-read path. SAFE.
- `src/modules/opportunistic-harvest.ts:406` — WRITER sets `sourceUserNickname: \`[harvest:...]\``, not a reader. SAFE.

```
rg "群内梗|fandom 事实|群友关系" src/
```
**NON-EMPTY** — hits in `fact-candidate-validator.ts` (incoming-candidate validator comment/rule), `opportunistic-harvest.ts` (LLM prompt string), `self-learning.ts` (prompt section label), `relationship-tracker.ts` (separate table). None are `learned_facts` topic readers. SAFE.

```
rg "opus-ext-classified" src/
```
**EMPTY** — confirmed no runtime reader. SAFE to purge.

**Verdict: NO BLOCKER. All three targets safe to proceed.**

## Must-NOT-affect scenarios
1. `群友别名 X` rows written by alias-miner (674 active) — Target 2 SQL must exclude via `topic NOT LIKE '群友别名%'` double-safety guard.
2. `user-taught:*` rows (13, tier 0) — no target touches `user-taught:` prefix; SQL filters are disjoint.
3. `opus-classified:slang` dedup KEEP winners (`NB`, `哦耶`, `到底是什么感觉`) — rule-based keep logic must not flip winners; only losers + noise get rejected.
4. `lore:%` rows — even if a `[harvest:]` row somehow has `lore:` in topic, add `AND topic NOT LIKE '%lore:%'` to Target 2.
5. `learned_facts` `fact` / `canonical_form` / `persona_form` / `occurrence_count` / `speaker_count` fields — script UPDATEs only `status='rejected'`; no other columns touched.
6. `opus-rest-classified:*` rows (2339) — no target filter overlaps; explicitly excluded from all three SQL predicates.

## Acceptance
- `tsc` clean (strict, no `--skipLibCheck` bypass).
- `vitest` new tests + full suite pass (baseline 4174 post-vulgar).
- Dry-run on `/tmp` copy of `data/bot.db`: Target 1 ~467, Target 2 ~900–1000, Target 3 8 rows reported.
- `--apply`: UPDATE count matches dry-run; `SELECT COUNT(*) FROM learned_facts` unchanged (no DELETE).
- Output summary includes: rejected-by-target counts, skipped counts, kept-duplicate winners list.

## Open Qs for Designer
1. Exact tiebreaker when `occurrence_count` + `speaker_count` both tied: `id DESC` sufficient or need another signal?
2. Noise list (`yes`, `周六`) — hardcoded array in script or accept `--noise-terms` CLI arg?
3. Output format: JSON to stdout, plain-text table, or both?
4. Han normalization for dedup key: `toLowerCase()` only (ASCII) or also map 繁→簡 (need a lib or manual map)?
