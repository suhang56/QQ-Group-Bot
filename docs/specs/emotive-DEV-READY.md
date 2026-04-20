# DEV-READY: R2a Emotive-Phrase Filter

## 1. File changes (exact list)

- **NEW** `src/utils/is-emotive-phrase.ts` — pure predicate module
- **MODIFY** `src/modules/chat.ts` — 1 line filter + 1 line import
- **NEW** `scripts/purge-emotive-facts.ts` — CLI, dry-run default
- **NEW** `test/is-emotive-phrase.test.ts` — predicate unit tests
- **NEW** `test/chat-emotive-filter.test.ts` — chat integration tests
- **NEW** `test/purge-emotive-facts.test.ts` — CLI fixture-DB tests

### Repo-convention overrides vs spec message (architect-resolved)

- Script path: **`scripts/`** flat, NOT `scripts/maintenance/` — `scripts/maintenance/` does not exist; `purge-honest-gaps-noise.ts` / `purge-jargon-sentences.ts` live at `scripts/` root.
- **NO `tsconfig.scripts.json`** — repo has only `tsconfig.json` (rootDir `src`, excludes `test`). Scripts run via `tsx` and are not tsc-checked. No tsconfig change needed.
- Test paths: **`test/*.test.ts` flat**, NOT `test/modules/` or `test/scripts/` — existing convention is `test/chat-ondemand-weak-leak.test.ts`, `test/purge-jargon-sentences.test.ts`.

## 2. TypeScript signatures

```ts
// src/utils/is-emotive-phrase.ts
export function isEmotivePhrase(term: string): boolean;
// Behavior: null/undefined-safe via typeof check — returns false for empty / whitespace-only / non-string.
// ALLOWLIST hard-pass: {笑死, 笑死我, 死鬼} → false.
// Regexes per DESIGN-NOTE (EXCLAMATION / INTENSIFIER / IMPERATIVE). True if any matches post-ALLOWLIST.

// scripts/purge-emotive-facts.ts — no exports; entry at bottom.
// Uses plain process.argv parsing (matches purge-honest-gaps-noise.ts style):
//   --db-path <path>  required (NO default — explicit DB path, do not read env DB_PATH)
//   --apply           boolean flag, default false (dry-run)
//   --verbose         boolean flag, default false
// Exit codes: 0 success, 1 runtime error, 2 bad args.
```

## 3. SQL queries (grep-verified columns)

Columns used (all verified `src/storage/schema.sql:212-230`): `id`, `group_id`, `topic`, `fact`, `status`, `updated_at`. ✓

FTS5 UPDATE trigger verified `schema.sql:261-266` — AFTER UPDATE on `learned_facts` fires `learned_facts_au` to delete+re-insert into `learned_facts_fts`. No manual FTS maintenance needed in purge.

```sql
-- SCAN: emotive rows in ondemand path
SELECT id, topic, fact, status FROM learned_facts
WHERE topic LIKE 'ondemand-lookup:%' AND status = 'active';

-- JS loop over rows:
--   term = extractTermFromTopic(row.topic)  // returns null if invalid suffix
--   if (term && isEmotivePhrase(term)) matchedIds.push(row.id)

-- APPLY (only if --apply): per-id UPDATE in a loop inside a BEGIN/COMMIT tx.
UPDATE learned_facts SET status = 'rejected', updated_at = ? WHERE id = ?;
-- Per-id (not IN (?,?,...)) to avoid dynamic-placeholder bloat on large matches;
-- verified pattern in markStatus (db.ts:2134).
-- updated_at unit = seconds (Math.floor(Date.now()/1000)) — matches insert (db.ts:1989).
```

## 4. Integration points

- **`src/utils/is-emotive-phrase.ts`** imports: nothing (zero side-effect, pure regex + Set literal).
- Imported by:
  - `src/modules/chat.ts` — add `import { isEmotivePhrase } from '../utils/is-emotive-phrase.js';` near line 47 (next to `isValidStructuredTerm` import, but a **separate `../utils/`** line — do not merge with `./fact-topic-prefixes.js`).
  - `scripts/purge-emotive-facts.ts` — `import { isEmotivePhrase } from '../src/utils/is-emotive-phrase.js';` (matches `purge-honest-gaps-noise.ts` style importing from `../src/modules/...`).
  - Test files — same relative `../src/utils/is-emotive-phrase.js`.
- **chat.ts change location**: `src/modules/chat.ts:3828` — replace line exactly:
  ```ts
  candidates = candidates.filter(isValidStructuredTerm).filter(t => !isEmotivePhrase(t));
  ```
  Inline chain, no new variable. No other lines in `_buildOnDemandBlock` change.
- **Purge script** imports `extractTermFromTopic` from `../src/modules/fact-topic-prefixes.js` (verified `fact-topic-prefixes.ts:53`).
- **No DB schema change. No ALTER migration. No repository method addition** — `markStatus(id, status)` already exists at `db.ts:2134`, but the script uses raw SQL (mirrors other purge scripts' direct-prepare pattern) so it can run against an ad-hoc DB path without instantiating the full Database class.

## 5. Test contract (vitest)

### 5.1 `test/is-emotive-phrase.test.ts` (18 cases)

REJECT (predicate returns true):
- `'烦死了'` / `'气死了'` / `'累死了'` — EXCLAMATION root+`了`
- `'崩了'` / `'麻了'` — EXCLAMATION root
- `'好烦'` / `'真累'` / `'太无语'` — INTENSIFIER
- `'不要烦'` / `'别吵'` / `'不准烦'` — IMPERATIVE

PASS (predicate returns false):
- `'笑死'` / `'笑死我'` / `'死鬼'` — ALLOWLIST hard-pass (MUST precede regex check)
- `'崩坏'` / `'麻弥'` — fandom terms with emotive-adjacent first char
- `'ykn'` / `'lsycx'` / `'宿傩'` / `'120w'` — jargon shapes

Boundary (predicate returns false):
- `''` (empty) / `'   '` (whitespace) / `null as any` / `undefined as any` / `42 as any` — non-string/empty inputs handled without throw.

### 5.2 `test/chat-emotive-filter.test.ts` (2 cases)

Follow setup pattern from `test/chat-ondemand-weak-leak.test.ts` (`makeMockDb()` + mock `OnDemandLookup` + construct `ChatModule`).

Test the `_buildOnDemandBlock` integration via a public entry point OR by exposing a tiny test seam — Dev chooses minimum-invasive approach. If `_buildOnDemandBlock` is not directly addressable from outside, drive it through the same public API that `chat-ondemand-weak-leak.test.ts` uses (`chat.handleMessage` or equivalent) and assert via `onDemandLookup.lookupTerm` mock call count.

- Case A: user message content includes `'不要烦'` → `onDemandLookup.lookupTerm` is **NOT** called (emotive filtered out pre-lookup).
- Case B: user message content is `'ykn是什么'` → `onDemandLookup.lookupTerm` **IS** called with `'ykn'` (non-emotive still passes).

### 5.3 `test/purge-emotive-facts.test.ts`

Pattern: follow `test/purge-jargon-sentences.test.ts` — spawn the script via `child_process` or direct `import.meta` invocation against a fixture DB. Dev picks whichever the sibling test already uses.

Fixture DB (in-memory via `new DatabaseSync(':memory:')` or `tmpdir + unlink`): `CREATE TABLE learned_facts (...)` matching schema.sql:212-230 columns; insert 5 rows:

| id | topic | fact | status | shape |
|---|---|---|---|---|
| 1 | `ondemand-lookup:烦死了` | (any) | active | emotive |
| 2 | `ondemand-lookup:气死了` | (any) | active | emotive |
| 3 | `ondemand-lookup:不要烦` | (any) | active | emotive |
| 4 | `ondemand-lookup:ykn`    | (any) | active | valid |
| 5 | `user-taught:ykn`        | (any) | active | non-ondemand |

- Case A (default, dry-run): run with `--db-path <fixture>` (no `--apply`) → exit 0. Assert: stdout contains `3 found, 0 would update`. Query all rows → all 5 still `status='active'`, all `updated_at` unchanged.
- Case B (`--apply`): run with `--db-path <fixture> --apply` → exit 0. Assert: stdout contains `3 found, 3 updated` (or similar). Query all rows → ids 1,2,3 now `status='rejected'` AND `updated_at` > seed value; ids 4,5 unchanged (`status='active'`, original `updated_at`).
- Case C (`--verbose`): dry-run with `--verbose` → stdout includes `[id=1]`, `[id=2]`, `[id=3]` lines naming each emotive term.
- Case D (missing `--db-path`): exit 2, stderr contains Usage.

### 5.4 Edge-test mandatory note (per bot-architect.md)

The EXCLAMATION regex anchors `崩了` / `麻了` as ROOTS (not suffixes) — `崩坏` / `麻弥` must be in PASS section of 5.1 to prove the regex does not over-reach. Case 5.1 `'崩坏'` / `'麻弥'` is the production-failure-mode edge.

## 6. Acceptance gate signal

**Dev hand-off (paste RAW last-10-lines per `feedback_escalate_opus_on_dev_fabricated_tests.md`)**:
- `npx tsc --noEmit` → clean (verifies chat.ts change + utils/ addition; script is outside tsc scope).
- `npx vitest run test/is-emotive-phrase.test.ts test/chat-emotive-filter.test.ts test/purge-emotive-facts.test.ts` → all green.
- `NODE_OPTIONS=--experimental-sqlite npx tsx scripts/purge-emotive-facts.ts --db-path <COPY of data/bot.db, NOT prod>` → show the "N found, 0 would update" line.
- SendMessage team-lead with raw outputs (no summary).

**Reviewer gate (4 checkpoints from TaskGet #5)**:
1. **Scope**: diff touches only 6 listed files + chat.ts line 3828 (single line). Zero unrelated edits.
2. **Fandom false-positive**: `'崩坏'` / `'麻弥'` PASS assertion present in 5.1; predicate not over-matching.
3. **Dry-run default**: purge script without `--apply` performs ZERO writes (5.3 Case A asserts `updated_at` unchanged).
4. **chat.ts scope**: only the `candidates` filter chain line changes; no changes to foundLines / weakLines / askUnknown / directKnownDirective logic.

Reviewer runs tsc + vitest + re-reads diff, does NOT re-run the real-DB purge (owner-runner territory if needed).

## Open questions resolved

- Q: Script dir `scripts/maintenance/` per team-lead vs `scripts/` per repo? → **A: `scripts/`** — grep-verified no `scripts/maintenance/` dir exists; sibling purges at `scripts/` root. Following repo convention.
- Q: `tsconfig.scripts.json` change? → **A: no such file; no change needed.** Scripts are tsx-run, not tsc-compiled. Spec message referenced a non-existent file.
- Q: Test dir `test/modules/` vs flat `test/`? → **A: flat `test/`** — sibling ondemand test is `test/chat-ondemand-weak-leak.test.ts`. `vitest.config.ts:36` globs `test/**/*.test.ts` so either works; flat matches convention.
- Q: Use existing `markStatus` or raw SQL in script? → **A: raw SQL** — purge sibling scripts use raw `db.prepare` against arbitrary DB paths. Avoids constructing full `Database` with embeddings backfill on a maintenance run.
- Q: `updated_at` unit? → **A: seconds** (`Math.floor(Date.now() / 1000)`), verified `db.ts:1989, 2136`.
- Q: FTS5 maintenance? → **A: automatic** — `learned_facts_au` AFTER UPDATE trigger fires on status flip (schema.sql:261-266).
