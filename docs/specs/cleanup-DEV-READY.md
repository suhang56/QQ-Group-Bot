# DEV-READY: legacy-classifier-junk purge

## 1. File changes
- `scripts/maintenance/purge-legacy-classifier-junk.ts` (NEW) — single CLI, `--target 1|2|3|all`, dry-run default.
- `test/scripts/purge-legacy-classifier-junk.test.ts` (NEW) — ≥15 vitest cases.

No `src/` / schema / trigger changes. `learned_facts_au` keeps FTS mirror in sync on `status` UPDATE.

## 2. TypeScript signatures

```ts
import { DatabaseSync } from 'node:sqlite';

export type TargetSelector = 1 | 2 | 3 | 'all';

export interface PurgeArgs {
  dbPath: string;
  target: TargetSelector;
  apply: boolean;
  verbose: boolean;
}

export interface Target1Result { found: number; updated: number; }
export interface Target2Result { found: number; updated: number; skippedAliasMiner: number; }
export interface Target3Result {
  found: number;            // candidates from SELECT (expected 50 on prod)
  updated: number;          // rows flipped (expected 5 on prod: 3 dedup + 2 noise)
  kept: ReadonlyArray<{ id: number; topic: string }>;
  rejected: ReadonlyArray<{ id: number; topic: string; reason: 'dedup-loser' | 'noise' }>;
}

export interface PurgeResult {
  target1: Target1Result;
  target2: Target2Result;
  target3: Target3Result;
  totalFound: number;
  totalUpdated: number;
}

export function runPurge(opts: {
  db: DatabaseSync;
  target: TargetSelector;
  apply: boolean;
  verbose: boolean;
  log?: (line: string) => void;
  now?: () => number;
}): PurgeResult;
```

Module entry mirrors PR5/#114 — `main(argv)` returns exit code; `invokedDirectly` guard calls `process.exit(main(...))`.

## 3. SQL (grep-verified columns)

Schema verified `src/storage/schema.sql:212-230` — columns: `id, topic, status, source_user_nickname, canonical_form, persona_form, fact, updated_at`. **`occurrence_count` / `speaker_count` DO NOT EXIST on `learned_facts`** (only on `groupmate_expression_samples`) — do not reference.

Target 1 SELECT:
```sql
SELECT id FROM learned_facts
 WHERE status = 'active'
   AND topic LIKE 'opus-ext-classified:%' ESCAPE '!'
   AND topic NOT LIKE '%lore:%' ESCAPE '!';
```

Target 2 SELECT:
```sql
SELECT id, source_user_nickname, topic FROM learned_facts
 WHERE status = 'active'
   AND topic NOT LIKE '%lore:%' ESCAPE '!'
   AND topic NOT LIKE '群友别名%' ESCAPE '!'           -- PRIMARY alias-miner guard (16 overlap rows protected)
   AND (source_user_nickname LIKE '[harvest:%' ESCAPE '!'
     OR source_user_nickname LIKE '[deep-tune:%' ESCAPE '!')
   AND source_user_nickname != '[alias-miner]';      -- belt-and-suspenders (disjoint prefixes; always false row-wise)
```

Target 3 SELECT (in-memory dedup follows):
```sql
SELECT id, topic, canonical_form, persona_form FROM learned_facts
 WHERE status = 'active'
   AND topic LIKE 'opus-classified:slang:%' ESCAPE '!'
   AND topic NOT LIKE '%lore:%' ESCAPE '!';
```

Batch UPDATE (per-target, inside one transaction):
```sql
UPDATE learned_facts SET status = 'rejected', updated_at = ? WHERE id = ?;
```
Prepare once, loop ids. Mirrors `purge-social-phrase-facts.ts:69-89`.

## 4. Integration — implementation outline

Imports: `node:sqlite`, `../../src/modules/fact-topic-prefixes.js` (`extractTermFromTopic`).

```ts
const LEXICAL_WINNERS: ReadonlyMap<string, string> = new Map([
  ['nb', 'NB'],                    // NB > nb
  ['欧耶', '哦耶'],                 // 哦耶 > 欧耶
  ['是什么感觉', '到底是什么感觉'],  // 到底是什么感觉 > 是什么感觉
]);
const OPUS_SLANG_NOISE_LIST: ReadonlySet<string> = new Set(['yes', '周六']);
```

Flow:
1. Parse args. `--target all` fans to 1,2,3.
2. **T1/T2** — reject every returned id (no in-memory filter; SQL guards already preserve alias-miner for T2).
3. **T3** in-memory: `term = extractTermFromTopic(row.topic)`. `term ∈ OPUS_SLANG_NOISE_LIST` → reject `noise`. Else if `term` is a LEXICAL_WINNERS key AND winner-term also in SELECT results → reject `dedup-loser`. Else keep. No case folding (`NB`/`nb` are distinct keys). Sort `rejected`/`kept` by `id ASC`.
4. One outer transaction: `BEGIN` → loop per target → `COMMIT` (rollback on error). Mirrors PR5.
5. Dry-run default skips UPDATEs. `--apply` persists. `--verbose` dumps per-row lines. Output to **stderr**.

Output (stderr):
```
[DRY RUN] Rows that would be updated:
  Target 1 (opus-ext-classified dead):     467 found, 467 would update
  Target 2 (batch-harvest junk):           909 found, 909 would update
  Target 3 (opus-classified:slang dedup):   50 found,   5 would update
    Kept (lexical): [NB, 哦耶, 到底是什么感觉]
    Rejected (dedup-loser): [nb, 欧耶, 是什么感觉]
    Rejected (noise):       [yes, 周六]
TOTAL: 1426 found, 1381 would update
```

## 5. Test contract (vitest, ≥15 cases)

Path: `test/scripts/purge-legacy-classifier-junk.test.ts`. Per-test fixture: `new DatabaseSync(':memory:')`, apply `schema.sql`, seed rows via INSERT. **No mocks** — real SQLite per `feedback_sqlite_schema_migration.md`.

Must-fire (flip to rejected on apply):
1. T1: `topic='opus-ext-classified:slang:X'` active → rejected.
2. T1: 3 rows seeded → rejected count = 3.
3. T2: `source_user_nickname='[harvest:foo]'`, `topic='群内梗:X'` → rejected.
4. T2: `source_user_nickname='[deep-tune:bar]'` → rejected.
5. T3 dedup: seed `:nb`+`:NB` → `nb` rejected, `NB` kept.
6. T3 dedup: seed `:欧耶`+`:哦耶` → `欧耶` rejected.
7. T3 dedup: seed `:是什么感觉`+`:到底是什么感觉` → `是什么感觉` rejected.
8. T3 noise: seed `:yes` (no winner pair) → rejected reason=noise.
9. T3 noise: seed `:周六` → rejected.

Must-NOT-fire (untouched after apply):
10. **16-row overlap (B3)**: `source_user_nickname='[harvest:X]'` + `topic='群友别名 小明'` → NOT in T2 result; status stays `active`.
11. Alias-miner: `source_user_nickname='[alias-miner]'` + `topic='群友别名 X'` → untouched.
12. Lore: `topic='opus-ext-classified:lore:xyz'` → untouched (T1 lore guard).
13. Lore: `source_user_nickname='[harvest:foo]'` + `topic='fandom:lore:abc'` → untouched (T2 lore guard).
14. `user-taught:*` → untouched (no prefix match).
15. `opus-rest-classified:slang:blah` → untouched (scope OUT).
16. `ondemand-lookup:xyz` → untouched.
17. T3 lexical WINNER `NB` alone (no `nb`) → untouched.
18. T3 unmatched slang `:我草` → untouched (not winner map, not noise).
19. Already-rejected T1 row → `updated_at` unchanged.

Determinism + invariants:
20. Two dry-runs on same fixture → sorted `rejected` id arrays equal.
21. `SELECT COUNT(*) FROM learned_facts` before `--apply` === after (no DELETE).
22. Rollback: stub UPDATE `.run` to throw mid-loop → all rows still active.

## 6. Acceptance gate signal

**Dev raw paste required:**
- `npx tsc --noEmit` clean (strict; no bypass).
- `npx vitest run test/scripts/purge-legacy-classifier-junk.test.ts` — all ≥15 cases pass.
- `npx vitest run` full suite — baseline 4174 post-vulgar (verify on fresh worktree; report absolute count).
- Dry-run on prod copy `/tmp/bot.db.work`:
  - **Target 1: 467 found / 467 would update** (verified prod ro query 2026-04-21).
  - **Target 2: 909 found / 909 would update** (verified).
  - **Target 3: 50 found / 5 would update** (3 dedup losers + 2 noise; 45 untouched).
- `--apply` on `/tmp` copy: `SELECT COUNT(*)` before === after; per-target update counts match dry-run.

**Reviewer spot-checks (to be logged in task #5):**
1. `grep -c 'DELETE FROM' scripts/maintenance/purge-legacy-classifier-junk.ts` → `0`.
2. alias-miner preservation: run the #10 overlap test + real-DB dry-run and confirm Target 2 result set contains zero rows where `topic LIKE '群友别名%'`.
3. Dedup determinism: two `--apply` runs on cloned fixture yield identical rejected-id arrays (sort + assert).

## Open questions resolved
- ESCAPE char: `ESCAPE '!'` (SQLite parser limit on `\`).
- Test path: `test/scripts/` (vitest includes `test/**/*.test.ts`; `test/integration/` excluded).
- No `occurrence_count`/`speaker_count` on `learned_facts` — tiebreaker is lexical table + `id DESC`.
- T3 prod count: 50 active (PLAN said 8). Rejects = 3 dedup losers + 2 noise = 5; 45 untouched.
- T2 alias-miner guard: `topic NOT LIKE '群友别名%'` is the real guard (16 prod overlap rows). `!= '[alias-miner]'` kept as redundant defence.
