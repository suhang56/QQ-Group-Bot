# Architect Handoff: Date Token Query Expansion (PR A)

**Branch:** `fix/date-token-expand`
**Worktree:** `D:/QQ-Group-Bot/.claude/worktrees/date-token-expand/`
**Master HEAD base:** `51ea3b6`
**Motivating bug:** #8347 — query `'618附近有哪些live'` missed facts id=2694, 2841 (stored as `'6月...'`).

This is the verbatim diff plan the Developer implements. Anything written here that contradicts PLAN or DESIGN supersedes them — both are reference, this is binding.

**Line pins re-verified at this morning's HEAD `51ea3b6`:** the DESIGN's lines 436 and 450 are correct against the current `src/modules/self-learning.ts`. No drift.

---

## §1. File 1 — NEW `src/utils/query-date-expand.ts`

Pure helper. No imports. ASCII single quotes only. Regex constants module-scoped. Idempotent against canonical forms already in the query. Caps at `MAX_DATES = 4` distinct dates per call. Returns input unchanged when no compact date detected. Helper normalizes input internally — caller never pre-trims or pre-lowercases.

```ts
// Pre-BM25 query rewriter: expands compact date tokens (618, 6/18, 6-18) to
// canonical Chinese forms (6月18号 / 6月18日 / 6月) so trigram FTS5 can match
// facts stored under canonical month-day text. Pure function, no I/O, no
// logger dependency — caller logs if it cares.

const MMDD_RE = /\b(\d{1,2})(\d{2})\b/g;
const SLASH_RE = /\b(\d{1,2})[\/\-](\d{1,2})\b/g;
const CANONICAL_MD_RE = /(\d{1,2})月(\d{1,2})[号日]/g;

const MAX_DATES = 4;

interface DateMatch { month: number; day: number; }

function isValidMonthDay(m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

function dateKey(m: number, d: number): string {
  return `${m}-${d}`;
}

function parseExistingCanonicals(query: string): Set<string> {
  const found = new Set<string>();
  for (const m of query.matchAll(CANONICAL_MD_RE)) {
    const month = parseInt(m[1]!, 10);
    const day = parseInt(m[2]!, 10);
    if (isValidMonthDay(month, day)) found.add(dateKey(month, day));
  }
  return found;
}

function parseDateTokens(query: string): DateMatch[] {
  const found: DateMatch[] = [];
  const seen = new Set<string>();

  for (const match of query.matchAll(MMDD_RE)) {
    const m = parseInt(match[1]!, 10);
    const d = parseInt(match[2]!, 10);
    if (!isValidMonthDay(m, d)) continue;
    const k = dateKey(m, d);
    if (seen.has(k)) continue;
    seen.add(k);
    found.push({ month: m, day: d });
  }
  for (const match of query.matchAll(SLASH_RE)) {
    const m = parseInt(match[1]!, 10);
    const d = parseInt(match[2]!, 10);
    if (!isValidMonthDay(m, d)) continue;
    const k = dateKey(m, d);
    if (seen.has(k)) continue;
    seen.add(k);
    found.push({ month: m, day: d });
  }
  return found;
}

/**
 * Expand date tokens in query for BM25/vector matching. Returns query
 * augmented with canonical Chinese date forms. Skips dates already canonical
 * in query (idempotent). Returns query unchanged when no compact date
 * detected. Caps at MAX_DATES=4 distinct dates to bound FTS query length.
 */
export function expandDateTokens(query: string): string {
  if (typeof query !== 'string' || query.length === 0) return query;

  const dates = parseDateTokens(query);
  if (dates.length === 0) return query;

  const existing = parseExistingCanonicals(query);
  const expansions: string[] = [];

  const capped = dates.slice(0, MAX_DATES);
  for (const { month, day } of capped) {
    if (existing.has(dateKey(month, day))) continue;
    expansions.push(`${month}月${day}号`);
    expansions.push(`${month}月${day}日`);
    expansions.push(`${month}月`);
  }

  if (expansions.length === 0) return query;
  return `${query} ${expansions.join(' ')}`;
}
```

**Refinements vs DESIGN §1 (architect-level decisions, not free choices for Developer):**

1. Added empty-string / non-string short-circuit at the top of `expandDateTokens` so the helper does not throw on bad input. The integration site already guards against null `triggerText`, but the helper must be safe in isolation (test T12 covers this).
2. Added non-null assertions (`match[1]!`) on regex group accesses — `matchAll` results have typed-undefined groups in strict TS, even when the regex guarantees the groups exist. Without the bang the file fails `tsc --noEmit`.
3. The `for ... continue` style replaces DESIGN's nested `if` blocks for readability. Behavior is identical.

**Idempotence semantics:** `parseExistingCanonicals` only suppresses the same `(month, day)` key. So `'6月18号 还有 6/19'` still expands `6/19` (T10). A query like `'6月 618'` — month-only canonical, no day — does NOT match `CANONICAL_MD_RE` (which requires day), so `618` still expands; this is correct because the user is explicitly asking about 6月18 and we want `6月18号 / 6月18日` appended.

---

## §2. File 2 — EDIT `src/modules/self-learning.ts`

**Verified line pins at `51ea3b6` HEAD:**
- Line 436: `triggerEmbedding = await svc!.embed(triggerText);`
- Line 450: `Promise.resolve(this.db.learnedFacts.searchByBM25(groupId, triggerText, BM25_TOP_K)),`

If your local file differs (re-base happened, etc.), abort and re-pin before editing.

### Edit 1 — Add import

Locate the existing import block at the top of `src/modules/self-learning.ts`. Add this import alongside the other `../utils/...` imports (alphabetical or grouped — match local style):

```ts
import { expandDateTokens } from '../utils/query-date-expand.js';
```

### Edit 2 — Compute `expandedQuery` once before line 433

Insert this block immediately before the existing line 433 (`let triggerEmbedding: number[] | null = null;`). Keep the surrounding blank lines intact:

```ts
    // Date-token expansion: rewrite compact dates (618, 6/18) to canonical
    // Chinese forms (6月18号 / 6月18日 / 6月) so BM25 trigram tokenizer matches
    // facts stored under canonical month-day text. Idempotent and additive —
    // expansion appends, never replaces. Helper is pure; logger sits here.
    const expandedQuery = expandDateTokens(triggerText);
    if (expandedQuery !== triggerText) {
      this.logger.debug(
        { groupId, originalLen: triggerText.length, expandedLen: expandedQuery.length },
        'date-token expansion applied',
      );
    }

```

### Edit 3 — Replace `triggerText` at line 436

```ts
// before:
        triggerEmbedding = await svc!.embed(triggerText);
// after:
        triggerEmbedding = await svc!.embed(expandedQuery);
```

### Edit 4 — Replace `triggerText` at line 450

```ts
// before:
      Promise.resolve(this.db.learnedFacts.searchByBM25(groupId, triggerText, BM25_TOP_K)),
// after:
      Promise.resolve(this.db.learnedFacts.searchByBM25(groupId, expandedQuery, BM25_TOP_K)),
```

**No other `triggerText` references in `formatFactsForPrompt` change.** Specifically, `extractCandidateTermsForFacts(triggerText)` at line 407 stays on `triggerText` — pre-pass exact-term lookup operates on user-typed terms, not expanded ones, by design.

**Net diff in `self-learning.ts`:** +1 import, +9 lines (4 comment + 1 const + 5 log block + 1 trailing blank), 2 in-place token swaps. Closely tracks DESIGN's "+8 LOC" estimate.

---

## §3. File 3 — NEW `test/utils/query-date-expand.test.ts`

Vitest. ASCII quotes only. 14 cases. Each `it()` body is 2-3 lines: arrange input string, call `expandDateTokens`, `expect(...).toBe(...)` or `.toContain(...)`.

```ts
import { describe, it, expect } from 'vitest';
import { expandDateTokens } from '../../src/utils/query-date-expand.js';

describe('expandDateTokens', () => {
  it('T1: 618 → appends 6月18号 6月18日 6月', () => {
    const out = expandDateTokens('618');
    expect(out).toBe('618 6月18号 6月18日 6月');
  });

  it('T2: 6/18 → appends canonical forms', () => {
    const out = expandDateTokens('6/18');
    expect(out).toBe('6/18 6月18号 6月18日 6月');
  });

  it('T3: 6-18 → appends canonical forms', () => {
    const out = expandDateTokens('6-18');
    expect(out).toBe('6-18 6月18号 6月18日 6月');
  });

  it('T4: motivating live case — 618附近有哪些live preserves prefix and appends', () => {
    const out = expandDateTokens('618附近有哪些live');
    expect(out).toContain('618附近有哪些live');
    expect(out).toContain('6月18号');
    expect(out).toContain('6月18日');
    expect(out).toContain('6月');
  });

  it('T5: idempotent — query already canonical 6月18号 returns unchanged', () => {
    const out = expandDateTokens('6月18号有什么活动');
    expect(out).toBe('6月18号有什么活动');
  });

  it('T6: invalid day — 999 (month=9, day=99) returns unchanged', () => {
    const out = expandDateTokens('999');
    expect(out).toBe('999');
  });

  it('T7: 4-digit leading-zero form — 0618 expands as 6/18', () => {
    const out = expandDateTokens('0618');
    expect(out).toContain('6月18号');
    expect(out).toContain('6月18日');
    expect(out).toContain('6月');
  });

  it('T8: phone number false-positive guard — 13800138000 returns unchanged', () => {
    const out = expandDateTokens('13800138000');
    expect(out).toBe('13800138000');
  });

  it('T9: max-boundary date — 12/31 expands to 12月31号 12月31日 12月', () => {
    const out = expandDateTokens('12/31');
    expect(out).toBe('12/31 12月31号 12月31日 12月');
  });

  it('T10: mixed canonical + new — 6月18号 还有 6/19 only expands 6/19', () => {
    const out = expandDateTokens('6月18号 还有 6/19');
    expect(out).toContain('6月19号');
    expect(out).toContain('6月19日');
    // 6月18 already canonical — must NOT be re-appended
    const occurrences = out.split('6月18号').length - 1;
    expect(occurrences).toBe(1);
  });

  it('T11: multiple compact tokens — 618 1231 expands both', () => {
    const out = expandDateTokens('618 1231');
    expect(out).toContain('6月18号');
    expect(out).toContain('12月31号');
    expect(out).toContain('12月');
  });

  it('T12 (edge): empty string returns empty string unchanged', () => {
    expect(expandDateTokens('')).toBe('');
  });

  it('T13: invalid month/day — 13/40 and 0/0 return unchanged', () => {
    expect(expandDateTokens('13/40')).toBe('13/40');
    expect(expandDateTokens('0/0')).toBe('0/0');
  });

  it('T14 (edge): MAX_DATES cap — 5+ distinct dates only first 4 expand', () => {
    // Five distinct dates: 1/1, 2/2, 3/3, 4/4, 5/5
    const out = expandDateTokens('1/1 2/2 3/3 4/4 5/5');
    expect(out).toContain('1月1号');
    expect(out).toContain('2月2号');
    expect(out).toContain('3月3号');
    expect(out).toContain('4月4号');
    // 5th date must NOT be expanded
    expect(out).not.toContain('5月5号');
    expect(out).not.toContain('5月5日');
  });
});
```

**Edge tests in this file (mandatory per project SOUL RULE):**
- T6 invalid day boundary (`999` → day=99 invalid)
- T8 phone-number guard (long digit run not matched as date by `\b...\b`)
- T12 empty input
- T13 invalid month/day boundaries (`13/40`, `0/0`)
- T14 MAX_DATES cap (5+ tokens)

These five edges are non-negotiable — Reviewer will scan for them.

---

## §4. File 4 — NEW `test/modules/self-learning-date-expand.test.ts`

Integration test. Real in-memory DB via `new Database(':memory:')`. Real `searchByBM25` path. No-op embedder so semantic path is dormant and BM25 carries retrieval.

Pattern mirrored from `test/modules/self-learning-meme.test.ts` (`makeDb`, `stubClaude`, `fakeEmbedder` with `isReady: false` to disable semantic path) and `test/bm25-search.test.ts` (real `db.learnedFacts.insert(...)` for seeding facts that flow through the FTS5 trigger).

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../src/storage/db.js';
import { SelfLearningModule } from '../../src/modules/self-learning.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../../src/ai/claude.js';
import type { IEmbeddingService } from '../../src/storage/embeddings.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeDb(): Database {
  return new Database(':memory:');
}

function stubClaude(): IClaudeClient {
  return {
    async complete(_req: ClaudeRequest): Promise<ClaudeResponse> {
      return { text: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
    async describeImage(): Promise<string> { return ''; },
  };
}

// Disabled embedder forces BM25-only retrieval — exactly the path the bug
// motivating this PR exercises. semanticEnabled=false in self-learning.ts.
function disabledEmbedder(): IEmbeddingService {
  return {
    isReady: false,
    async embed(_text: string): Promise<number[]> { return []; },
    async waitReady(): Promise<void> {},
  };
}

function seedFact(db: Database, groupId: string, fact: string, canonical: string | null): number {
  return db.learnedFacts.insert({
    groupId,
    topic: null,
    fact,
    canonicalForm: canonical,
    personaForm: null,
    sourceUserId: null,
    sourceUserNickname: null,
    sourceMsgId: null,
    botReplyId: null,
    status: 'active',
  });
}

describe('SelfLearningModule formatFactsForPrompt — date-token expansion', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('I1: 618 query retrieves fact stored as 6月Boot IGNITION', async () => {
    const seededId = seedFact(db, 'g1', '6月Boot IGNITION live', '6月Boot IGNITION live');
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: disabledEmbedder(),
    });

    const result = await learner.formatFactsForPrompt('g1', 50, '618附近有哪些live');
    expect(result.matchedFactIds).toContain(seededId);
  });

  it('I2: 6/18 slash form retrieves the same 6月-canonical fact', async () => {
    const seededId = seedFact(db, 'g1', '6月Boot IGNITION live', '6月Boot IGNITION live');
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: disabledEmbedder(),
    });

    const result = await learner.formatFactsForPrompt('g1', 50, '6/18 live');
    expect(result.matchedFactIds).toContain(seededId);
  });

  it('I3: non-date query baseline — BanG Dream fes still retrieves matching fact', async () => {
    const seededId = seedFact(db, 'g1', 'BanG Dream 7th Anniversary fes', 'BanG Dream 7th Anniversary fes');
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: disabledEmbedder(),
    });

    const result = await learner.formatFactsForPrompt('g1', 50, 'BanG Dream fes');
    expect(result.matchedFactIds).toContain(seededId);
  });

  it('I4: query with no date and no overlap — date-fact NOT retrieved (no false positive)', async () => {
    seedFact(db, 'g1', '6月Boot IGNITION live', '6月Boot IGNITION live');
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: disabledEmbedder(),
    });

    // '随便聊聊' has no overlap with '6月Boot IGNITION'. Expansion must not fire
    // (no date tokens), so retrieval depends purely on BM25 on the original.
    const result = await learner.formatFactsForPrompt('g1', 50, '随便聊聊');
    expect(result.matchedFactIds).toHaveLength(0);
  });

  it('I5: 12/31 retrieves fact stored as 12月31日跨年演唱会', async () => {
    const seededId = seedFact(db, 'g1', '12月31日跨年演唱会', '12月31日跨年演唱会');
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: disabledEmbedder(),
    });

    const result = await learner.formatFactsForPrompt('g1', 50, '12/31 跨年');
    expect(result.matchedFactIds).toContain(seededId);
  });

  it('I6: idempotence — query "6月18号 还有 6/19" with seeded 6月19日 fact retrieves it without 6/18 double-expansion', async () => {
    const seededId = seedFact(db, 'g1', '6月19日附加场', '6月19日附加场');
    const learner = new SelfLearningModule({
      db, claude: stubClaude(), embeddingService: disabledEmbedder(),
    });

    const result = await learner.formatFactsForPrompt('g1', 50, '6月18号 还有 6/19');
    expect(result.matchedFactIds).toContain(seededId);
  });
});
```

**Notes for Developer on integration test fixtures:**

- `db.learnedFacts.insert(...)` is the public seeding entry point per `test/bm25-search.test.ts:21-29`. The FTS5 trigger fires automatically on insert.
- `IEmbeddingService.isReady = false` disables the semantic path inside `formatFactsForPrompt` (`semanticEnabled = svc !== null && svc.isReady`), so BM25 is the only retrieval path. This is the exact production failure mode in bug #8347 (embedder up but BM25 missed) — but disabling the semantic side keeps the test deterministic.
- Assertion target is `result.matchedFactIds` (NOT `injectedFactIds`). Per `self-learning.ts:140-150`, `matchedFactIds` is the subset of injected ids that came from actual BM25/vector hits — exactly what we are testing improved.
- If a test goes red because BM25 trigram tokenizer produces no overlap on the canonical-tokens path, the failure proves the expansion is wired wrong; do NOT lower the assertion to `injectedFactIds.length > 0`.

---

## §5. Iteration Contract

| File | Change | Size |
|------|--------|------|
| `src/utils/query-date-expand.ts` | NEW pure helper | ~85 LOC |
| `src/modules/self-learning.ts` | +1 import, +9 lines, 2 in-place swaps | +10 LOC |
| `test/utils/query-date-expand.test.ts` | NEW unit tests, 14 cases | ~95 LOC |
| `test/modules/self-learning-date-expand.test.ts` | NEW integration tests, 6 cases | ~125 LOC |

**Total LOC budget:** ~315 LOC across 4 files (1 new helper, 1 edit, 2 new test files). No DB schema changes. No config changes. No `chat.ts` changes.

**Acceptance criteria (Reviewer gate):**
1. `npx tsc --noEmit` from worktree root: 0 errors.
2. `cd worker && npx vitest run test/utils/query-date-expand.test.ts test/modules/self-learning-date-expand.test.ts`: 20/20 pass (14 unit + 6 integration).

   *Note:* if the project's vitest config is at the worktree root (no `worker/` subdir), run `npx vitest run` from the worktree root with the same two files. Developer should resolve based on what's actually present (`bm25-search.test.ts` lives at `test/`, suggesting root-level vitest). The standing rule "bangdream-na has no CI; Reviewer must run vitest locally" does NOT apply here — this is QQ-Group-Bot.
3. Full repo `npx vitest run` (Reviewer's pass): no regression in other suites.
4. Build: `npx tsc --noEmit` passes.

**Push behavior:**
- Developer pushes branch `fix/date-token-expand` to origin after the commit.
- Developer does NOT open a PR. Reviewer audits first; team-lead opens the PR after Reviewer APPROVED.

---

## §6. Commit Message (verbatim)

```
feat(retrieval): pre-BM25 date-token query expansion — close 618→6月 fact-retrieval gap
```

No body required. No `Co-Authored-By` line. No emojis. No `.claude/` paths in the diff. Conventional-commit format only.

---

## §7. Standing Rules — Quote Verbatim for the Developer

These are project rules from user memory. They apply unconditionally to this PR.

1. **ASCII single quotes only.** No smart quotes (U+2018 `'`, U+2019 `'`, U+201C `"`, U+201D `"`). They break `tsc` with `Invalid character`. Same applies to test files. If the editor auto-converts, manually replace.

2. **No `${null}` template literals.** Assemble nullable parts via `[a, b].filter(Boolean).join(' ')` — `${null}` renders the literal string `'null'` and pollutes downstream matching. Not directly relevant in this PR's surface, but worth holding the line.

3. **Helpers normalize input internally — do not require callers to pre-normalize.** `expandDateTokens` accepts raw `triggerText`. The caller (`self-learning.ts`) does NOT pre-trim, lowercase, or sanitize.

4. **Edge tests mandatory (project SOUL RULE).** Five edges in §3 are non-negotiable: empty, MAX_DATES cap, canonical-already-present, invalid month/day, phone-number false-positive. Reviewer scans for them.

5. **Push branch but do NOT open PR.** Developer commits → pushes → signals DONE. Reviewer goes first. Team-lead opens PR after Reviewer APPROVED.

6. **No `.claude/` paths in any commit.** `.claude/` is gitignored repo-wide. If `git status` ever shows a `.claude/` path staged, unstage it before committing.

7. **No `Co-Authored-By` line in commit message.** User feedback rule. Single-line conventional commit only.

8. **Bash cwd drift — always operate in the worktree explicitly.** Worktree path: `D:/QQ-Group-Bot/.claude/worktrees/date-token-expand/`. Either `cd` to it before every shell call, or use `git -C <worktree>` form. Edits land via absolute paths regardless, but `git add` must run inside the worktree. (Memory rule: cwd drift across turns misroutes commits to the main repo.)

9. **Verify remote before re-correcting.** If anything looks off after Developer pushes, run `git show origin/fix/date-token-expand` first — race-corrections happen.

10. **Validator at every boundary.** `expandDateTokens` is the producer. The two consumers are `svc.embed(...)` and `searchByBM25(...)`. No third caller in this PR. If a future caller appears, it MUST also use `expandDateTokens` — do not bypass.

---

## §OQ5 (post-defect addendum) — FTS5 phrase-literal AND, not OR

**Defect found by Developer pre-commit:** §OQ1's claim that the expanded query "passes through sanitization intact and each becomes a quoted FTS5 phrase-literal" is correct, but missed that adjacent FTS5 phrase literals are joined with **implicit AND**, not OR. `sanitizeFtsQuery` (`src/utils/text-tokenize.ts:81`) splits on whitespace and emits `"phrase1" "phrase2" "phrase3"` — every phrase must appear in the document.

Consequence: a query like `'618附近有哪些live 6月18号 6月18日 6月'` becomes `"618附近有哪些live" "6月18号" "6月18日" "6月"` — the doc must contain ALL FOUR phrases. The seeded fact `'6月18日 Boot IGNITION live'` does NOT contain `"618附近有哪些live"`, so the AND short-circuits to zero rows. Appending tokens INTERSECTS, not UNIONS — the opposite of what the PR needs.

**Corrected helper API:**

```ts
export interface ExpandedQuery {
  baseQuery: string;       // original triggerText, unchanged
  alternates: string[];    // canonical alternates as separate strings
}
export function expandDateTokens(query: string): ExpandedQuery;
```

**Corrected integration shape (self-learning.ts):**

- `1 + alternates.length` BM25 calls in parallel inside the existing `Promise.all`:
  - 1x `searchByBM25(groupId, baseQuery, BM25_TOP_K)`
  - N x `searchByBM25(groupId, alternate, BM25_TOP_K)`
- Union row sets: dedup by `fact.id`, preserve first-seen order so baseQuery hits rank above alternate-only hits, slice to `BM25_TOP_K`.
- Vector embed: `svc.embed(baseQuery + ' ' + alternates.join(' '))` — concatenation is centroid-blend, AND/OR moot.

**Trigram tokenizer floor (secondary defect uncovered):** FTS5 trigram tokenizer requires a 3-char window. The month-only alternate `'6月'` (2 chars) cannot match standalone — confirmed by `test/bm25-search.test.ts:74` ("Query is 3+ chars because trigram tokenizer needs a 3-char window"). The day-form alternates `'6月18号'` and `'6月18日'` (4 chars each) DO trigram-match canonical doc text. Therefore the integration tests seed canonical-date-form doc text (`'6月18日 Boot IGNITION live'`) — production rows id=2694/2841 cited in PLAN must already contain the 4-char canonical form for the fix to recover them; if those rows truly contain only the 2-char `'6月'`, a separate fix path (DB-side normalization or query-side bigram fallback) would be needed.

LOC delta vs original budget: helper +6, self-learning.ts +5, unit tests +10 — still well under 350 LOC total.

---

## §8. Architect Notes (non-binding context for Developer)

- **Why BM25 misses `618` against `6月`:** FTS5 trigram tokenizer windows are `[6,1,8]`, `[1,8,X]`, etc. against the query, vs `[6,月,1]`, `[月,1,8]`, etc. against the doc. Zero trigram overlap → zero BM25 score on those rows. Appending `6月18号 6月18日 6月` introduces overlapping trigrams (`[6,月,1]`, `[月,1,8]`, `[6,月]`-style 2-grams in some tokenizer modes) and gives BM25 a legitimate score path.
- **Why include `6月` (month-only) in the expansion:** Per PLAN evidence — id=2694 and id=2841 contain only `6月` in their canonical text, no day. Without month-only token, those rows still score zero. The cost is ~3 extra tokens per query, well below FTS5 limits at MAX_DATES=4.
- **Why pure helper, no logger:** Matches the project's existing utils pattern (`text-tokenize.ts`, `redline-fact-filter.ts`). The integration site logs once after computation; helper stays testable in isolation.
- **Why `\b(\d{1,2})(\d{2})\b` instead of separate 3-digit and 4-digit regexes:** A single regex with `(\d{1,2})(\d{2})` matches both `'618'` (1+2 digits) and `'0618'` (2+2 digits) in one pass. The `\b` word-boundaries prevent greedy match against longer digit runs (phone numbers).
- **Why slash and dash in same regex `[\/\-]`:** They have identical semantics for date separators. Single pass, single dedup key.
- **What's deliberately NOT in this PR:** Year-aware expansion, range queries (`5月后`, `之前`), Chinese-numeral parsing (`六一八`), DB-side normalization. Per PLAN §5 — separate workstreams.

---

End of architect handoff. Developer implements §1-§4 verbatim, commits per §6, follows §7 verbatim. Reviewer audits to §5 acceptance criteria.
