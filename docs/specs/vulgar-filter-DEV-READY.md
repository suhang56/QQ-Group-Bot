# DEV-READY: R2.5.1-annex — Vulgar-Dismissal Filter + Purge

## 1. File changes (exact list)

- NEW `src/utils/is-vulgar-dismissal.ts` — pure predicate + pattern const + empty ALLOWLIST
- MODIFY `src/modules/chat.ts` — 1 import (line 48 area) + append `.filter(t => !isVulgarDismissal(t))` to chain at line 4221
- NEW `scripts/maintenance/purge-vulgar-phrase-facts.ts` — CLI + `runPurge` export (PR5 `purge-social-phrase-facts.ts` shape)
- NEW `test/utils/is-vulgar-dismissal.test.ts` — ≥12 must-fire + ≥10 must-NOT-fire
- NEW `test/modules/chat-vulgar-filter.test.ts` — integration: `你懂个毛` trigger → `onDemandLookup.lookupTerm` spy 0 calls; `ykn` trigger → called
- NEW `test/scripts/purge-vulgar-phrase-facts.test.ts` — dry-run, --apply, lore-exempt, user-taught-exempt

## 2. TypeScript signatures

```ts
// src/utils/is-vulgar-dismissal.ts
export const VULGAR_DISMISSAL_PATTERNS: readonly RegExp[];
export const VULGAR_DISMISSAL_ALLOWLIST: ReadonlySet<string>;  // empty; kept for parity with is-emotive-phrase
export function isVulgarDismissal(term: unknown): boolean;

// scripts/maintenance/purge-vulgar-phrase-facts.ts
export interface PurgeResult {
  found: number;
  updated: number;
  skippedLoreCount: number;
  skippedNonVulgarCount: number;
  matched: ReadonlyArray<{ id: number; topic: string; fact: string; status: string }>;
}
export function runPurge(opts: {
  db: DatabaseSync; apply: boolean; verbose: boolean;
  log?: (line: string) => void; now?: () => number;
}): PurgeResult;
```

Predicate body (per Designer §Q4; mirrors `is-emotive-phrase.ts` guard ordering):

```ts
const VULGAR_DISMISSAL_RE =
  /^(?:你?懂个(?:毛|屁|锤子|鬼|啥|蛋)|你(?:个|才)(?:屁|毛|傻|二|蠢)|去你的|滚你的|管你屁事)$/u;
export const VULGAR_DISMISSAL_PATTERNS = [VULGAR_DISMISSAL_RE] as const;
export const VULGAR_DISMISSAL_ALLOWLIST: ReadonlySet<string> = new Set();
export function isVulgarDismissal(term: unknown): boolean {
  if (typeof term !== 'string' || term.trim().length === 0) return false;
  if (VULGAR_DISMISSAL_ALLOWLIST.has(term)) return false;
  return VULGAR_DISMISSAL_RE.test(term);
}
```

## 3. SQL (grep-verified columns — schema.sql:213-229, FTS triggers schema.sql:251-266)

Columns used: `id`, `topic`, `fact`, `canonical_form`, `status`, `updated_at` — all verified on `learned_facts`.
FTS auto-sync: `learned_facts_au` UPDATE trigger (schema.sql:261) re-inserts on UPDATE → no manual FTS touch needed.

```sql
-- SELECT (mirrors PR5 SELECT_SQL shape; adds ondemand-lookup: prefix per Designer Q2)
SELECT id, topic, fact, canonical_form, status, updated_at
  FROM learned_facts
 WHERE status != 'rejected'
   AND (topic LIKE 'ondemand-lookup:%'         ESCAPE '!'
     OR topic LIKE 'opus-classified:slang:%'   ESCAPE '!'
     OR topic LIKE 'opus-rest-classified:slang:%' ESCAPE '!')
   AND topic NOT LIKE '%lore:%' ESCAPE '!';

-- In-memory: for each row, term = extractTermFromTopic(topic); keep iff isVulgarDismissal(term)
-- Lore-skipped count (separate COUNT(*) for operator visibility — PR5 pattern):
SELECT COUNT(*) AS n FROM learned_facts
 WHERE status != 'rejected'
   AND (topic LIKE 'ondemand-lookup:%' ESCAPE '!'
     OR topic LIKE 'opus-classified:slang:%' ESCAPE '!'
     OR topic LIKE 'opus-rest-classified:slang:%' ESCAPE '!')
   AND topic LIKE '%lore:%' ESCAPE '!';

-- UPDATE (per-id, inside BEGIN/COMMIT; PR5 pattern — no bulk IN clause):
UPDATE learned_facts SET status='rejected', updated_at=? WHERE id=?;
```

## 4. Integration points

- chat.ts:48 already imports `isEmotivePhrase` from `../utils/is-emotive-phrase.js`; add sibling import `isVulgarDismissal` from `../utils/is-vulgar-dismissal.js`.
- chat.ts:4221 current (grep-verified): `candidates = candidates.filter(isValidStructuredTerm).filter(t => !isEmotivePhrase(t));` → replace with 3-step chain ending `.filter(t => !isVulgarDismissal(t));`.
- Purge script imports `extractTermFromTopic` from `../../src/modules/fact-topic-prefixes.js` (PR5 pattern).
- NO schema migration — predicate code-only; purge touches only existing columns. FTS sync via `learned_facts_au` (schema.sql:261) on per-row UPDATE.

## 5. Test contract (vitest)

### `test/utils/is-vulgar-dismissal.test.ts`

Must-fire (≥12 — returns `true`):
- `你懂个毛`, `懂个毛`, `你懂个屁`, `懂个屁`, `你懂个锤子`, `懂个锤子`
- `你懂个鬼`, `懂个鬼`, `你懂个啥`, `懂个啥`, `你懂个蛋`, `懂个蛋`
- `你个屁`, `你个毛`, `你才屁`, `你才傻`
- `去你的`, `滚你的`, `管你屁事`

Must-NOT-fire (≥10 — returns `false`):
- `他懂个屁`, `她懂个毛` (3rd-person)
- `我懂了`, `你懂吗`, `你知道吗` (no vulgar trailing token)
- `''`, `'   '` (empty/whitespace)
- `懂者自懂`, `zdjd` (lore fandom)
- `二次元`, `二选一` (`二` in lore, not bare dismissal)
- `ykn`, `laplace` (fandom / unrelated)
- `傻逼`, `sb` (PR2 harassment gate covers — must NOT re-fire here; keeps family scope clean)
- `今天的演出真的懂个毛啊，是什么感觉` (long-sentence embed — never becomes bare term but assert anyway)
- Non-string: `null`, `undefined`, `123` → `false`

### `test/modules/chat-vulgar-filter.test.ts` (integration)

- Stub `onDemandLookup.lookupTerm` as vitest spy.
- Feed content containing `你懂个毛` → invoke `_buildOnDemandBlock`-equivalent path → assert spy called 0 times for `你懂个毛` term (other candidates may still lookup).
- Feed content containing `ykn` (fandom, passes filter) → assert spy called ≥1 time with `ykn`.
- Assert returned `block === ''` when only vulgar candidates present.

### `test/scripts/purge-vulgar-phrase-facts.test.ts`

Fixture DB seed (in-memory `DatabaseSync(':memory:')`, apply schema.sql, INSERT 8 rows):
- 3 × `ondemand-lookup:<vulgar>` active (incl. `你懂个毛`)
- 2 × `opus-classified:slang:<vulgar>` active (`你个屁`, `懂个锤子`)
- 1 × `lore:xxx:你懂个屁` active (lore-exempt)
- 1 × `user-taught:...` active (user-taught-exempt — no prefix match)
- 2 × `ondemand-lookup:<non-vulgar>` active (`ykn`, `laplace`)

Assertions:
- Dry-run: `found === 5`, `updated === 0`; lore row, user-taught row, non-vulgar rows unchanged.
- `--apply`: `found === 5`, `updated === 5`, status=`rejected` on the 5; lore / user-taught / non-vulgar still `active`; `SELECT COUNT(*)` unchanged (UPDATE only, no DELETE).
- `--verbose`: stdout contains `[id=...]` lines for each matched row.
- Parse-args: missing `--db-path` returns exit code 2.

## 6. Acceptance + Reviewer spot-checks

### Dev raw paste mandatory (in handoff message)
- `npx tsc --noEmit` twice clean (strict).
- `npx vitest run` last-10 lines — new tests pass + full baseline 4116 all green, no regress on R2a / R2.5.1 / PR1-4 tags.
- Dry-run on `/tmp/bot-db-copy.db` (copy of `data/bot.db`): output must include factId=5488 `你懂个毛` (verified present, topic=`opus-rest-classified:slang:你懂个毛`). factId=5188 same-topic duplicate also expected.
- `--apply` on the copy: `updated === found`; re-run dry-run → `found === 0`; `SELECT COUNT(*) FROM learned_facts` identical before/after.

### Reviewer 3 spot-checks (task #5 description)
1. **Scope**: `git diff --name-only origin/master...HEAD` limited to 1 NEW util + 1 chat.ts MODIFY + 1 NEW script + 3 NEW tests.
2. **Purge safety**: `grep -c 'DELETE FROM' scripts/maintenance/purge-vulgar-phrase-facts.ts` == 0; dry-run is default (no `--apply` ⇒ no writes); lore exempt verified in fixture test.
3. **Chain order**: `grep -n "filter" src/modules/chat.ts` shows `isVulgarDismissal` AFTER `isEmotivePhrase` on line 4221-ish.
4. **Real-DB dry-run**: Reviewer runs `NODE_OPTIONS=--experimental-sqlite npx tsx scripts/maintenance/purge-vulgar-phrase-facts.ts --db-path /tmp/bot-copy.db --verbose` → must list factId=5488 `你懂个毛`.

## Open questions & grep-verified refs

- All 4 Designer Qs resolved (Q1 exact-match `^…$`; Q2 3 prefixes; Q3 empty ALLOWLIST; Q4 separate module).
- chat.ts:4221 filter chain, chat.ts:48 import — grep-verified (Designer/Planner line 4221 both correct).
- schema.sql:213-229 `learned_facts` columns; schema.sql:251-266 FTS triggers incl. `learned_facts_au` UPDATE.
- Prod DB probe: factId=5488 active topic=`opus-rest-classified:slang:你懂个毛`; factId=5188 same-topic duplicate.
