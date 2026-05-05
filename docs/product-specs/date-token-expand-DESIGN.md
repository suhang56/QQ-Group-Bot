# Design: Date Token Query Expansion

## §1. Helper Module `src/utils/query-date-expand.ts` (NEW)

```ts
const MMDD_RE = /\b(\d{1,2})(\d{2})\b/g;
const SLASH_RE = /\b(\d{1,2})[\/\-](\d{1,2})\b/g;
const CANONICAL_MD_RE = /(\d{1,2})月(\d{1,2})[号日]/g;

const MAX_DATES = 4;

interface DateMatch { month: number; day: number; }

function isValidMonthDay(m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

function dateKey(m: number, d: number): string { return `${m}-${d}`; }

function parseExistingCanonicals(query: string): Set<string> {
  const found = new Set<string>();
  for (const m of query.matchAll(CANONICAL_MD_RE)) {
    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    if (isValidMonthDay(month, day)) found.add(dateKey(month, day));
  }
  return found;
}

function parseDateTokens(query: string): DateMatch[] {
  const found: DateMatch[] = [];
  const seen = new Set<string>();

  for (const match of query.matchAll(MMDD_RE)) {
    const m = parseInt(match[1], 10);
    const d = parseInt(match[2], 10);
    if (isValidMonthDay(m, d)) {
      const k = dateKey(m, d);
      if (!seen.has(k)) { seen.add(k); found.push({ month: m, day: d }); }
    }
  }
  for (const match of query.matchAll(SLASH_RE)) {
    const m = parseInt(match[1], 10);
    const d = parseInt(match[2], 10);
    if (isValidMonthDay(m, d)) {
      const k = dateKey(m, d);
      if (!seen.has(k)) { seen.add(k); found.push({ month: m, day: d }); }
    }
  }
  return found;
}

/**
 * Expand date tokens in query for BM25/vector matching.
 * Returns query augmented with canonical Chinese date forms.
 * Skips dates already canonical in query (idempotent).
 * Returns query unchanged when no compact dates detected.
 * Caps at MAX_DATES=4 to prevent token bloat.
 */
export function expandDateTokens(query: string): string {
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

  return expansions.length === 0 ? query : `${query} ${expansions.join(' ')}`;
}
```

---

## §2. Planner OQ Resolutions

### OQ1 — sanitizeFtsQuery survival

`sanitizeFtsQuery` (src/utils/text-tokenize.ts) strips only ASCII operator chars `"*:^()-+`, then wraps tokens in double-quotes. Chinese characters (CJK) and ASCII digits are NOT stripped.

Expanded tokens like `6月18号`, `6月18日`, `6月` contain only CJK + digits — they pass through sanitization intact and each becomes a quoted FTS5 phrase-literal. **No design adjustment needed.**

One edge case: the `-` in a dash-form query like `6-18` is stripped by sanitize, leaving the bare `618` token, which is still valid. The canonical expansions appended before sanitize survive separately. **No issue.**

### OQ2 — Token cap

Per-query cap: `MAX_DATES = 4`. Expansion adds 3 forms x N dates:
- 1 date = 3 expansion tokens
- 2 dates = 6 tokens
- 4 dates (cap) = 12 tokens

Dates beyond position 4 are silently dropped. This prevents pathological FTS query length from concert-schedule paste inputs.

### OQ3 — embed vs BM25-only

Apply expansion to **BOTH** BM25 and vector embed query. Rationale:
- BM25 benefit is clear (trigram overlap with canonical stored form)
- Vector benefit: embedding `618附近有哪些live 6月18号 6月18日 6月` vs `618附近有哪些live` — the canonical tokens shift the embedding centroid toward date-related facts at low additional token cost
- Single `expandedQuery` computed once, passed to both paths — no duplication of logic

### OQ4 — Logging

Debug-level log when expansion fires, following existing logger pattern:

```ts
if (expandedQuery !== triggerText) {
  this.logger.debug(
    { groupId, originalLen: triggerText.length, expandedLen: expandedQuery.length },
    'date-token expansion applied'
  );
}
```

Place immediately after computing `expandedQuery` in `formatFactsForPrompt`.

---

## §3. self-learning.ts Integration

**Target:** `src/modules/self-learning.ts`, inside `formatFactsForPrompt`.

**Exact lines affected:**
- Line 436: `triggerEmbedding = await svc!.embed(triggerText);`
- Line 450: `Promise.resolve(this.db.learnedFacts.searchByBM25(groupId, triggerText, BM25_TOP_K))`

**Change:**

Compute `expandedQuery` ONCE, immediately before the `triggerEmbedding` try block (before line 434):

```ts
import { expandDateTokens } from '../utils/query-date-expand.js';

// inside formatFactsForPrompt, before triggerEmbedding block:
const expandedQuery = expandDateTokens(triggerText);
if (expandedQuery !== triggerText) {
  this.logger.debug(
    { groupId, originalLen: triggerText.length, expandedLen: expandedQuery.length },
    'date-token expansion applied'
  );
}
```

Then replace both call sites:
- Line 436: `svc!.embed(triggerText)` → `svc!.embed(expandedQuery)`
- Line 450: `searchByBM25(groupId, triggerText, BM25_TOP_K)` → `searchByBM25(groupId, expandedQuery, BM25_TOP_K)`

`triggerText` parameter itself is unchanged — used only for these two calls; all other uses in the function remain on `triggerText`.

Net diff: +1 import line, +5 lines (expandedQuery compute + log), +2 call-site replacements = **+8 LOC** in self-learning.ts.

---

## §4. Test Matrix: `test/utils/query-date-expand.test.ts` (NEW, ~14 cases)

| ID | Input | Expected output | Rationale |
|----|-------|----------------|-----------|
| T1 | `'618'` | appends `'6月18号 6月18日 6月'` | Primary compact form |
| T2 | `'6/18'` | appends `'6月18号 6月18日 6月'` | Slash form |
| T3 | `'6-18'` | appends `'6月18号 6月18日 6月'` | Dash form |
| T4 | `'618附近有哪些live'` | appends date tokens, preserves rest | Motivating live case |
| T5 | `'6月18号'` (canonical) | unchanged | Idempotent: parseExistingCanonicals detects it |
| T6 | `'999'` | unchanged | month=9 day=99 → invalid (d>31) |
| T7 | `'0618'` | appends `'6月18号 6月18日 6月'` | 4-digit leading-zero form |
| T8 | `'13800138000'` | unchanged | 11 digits — `\b(\d{1,2})(\d{2})\b` boundary prevents match on middle of long int |
| T9 | `'12/31'` | appends `'12月31号 12月31日 12月'` | Max valid boundary |
| T10 | `'6月18号 还有 6/19?'` | appends only `'6月19号 6月19日 6月'` | 6/18 already canonical → skipped; 6/19 is new |
| T11 | `'618 1231'` | appends expansions for both 6/18 and 12/31 | Multiple compact tokens |
| T12 | `''` | `''` | Empty query passthrough |
| T13 | `'0/0'` and `'13/40'` | unchanged | Invalid: 0/0 fails month>=1; 13/40 fails month<=12 |
| T14 | query with 5 distinct date tokens | only first 4 expanded (12 tokens) | MAX_DATES=4 cap |

---

## §5. Test Matrix: `test/modules/self-learning-date-expand.test.ts` (NEW, ~6 integration)

| ID | Setup | Query | Assertion |
|----|-------|-------|-----------|
| T1 | Seed DB fact id=2694: `'6月Boot IGNITION'` | `'618 live'` | BM25 results include id=2694 |
| T2 | Same seed | `'6/18 live'` | id=2694 included |
| T3 | Same seed | `'BanG Dream fes'` (no date tokens) | Baseline unchanged; no regression |
| T4 | Any seed | `'随便聊聊'` | No date expansion; retrieval unaffected |
| T5 | Seed fact `'12月31日跨年演唱会'` | `'12/31 跨年'` | 12月31 fact retrieved |
| T6 | Seed fact with `'6月18号'` | `'6月18号 还有 6/19'` | No double-expansion of 6/18; 6/19 expansion fires |

---

## §6. Iteration Contract

| File | Change | Size |
|------|--------|------|
| `src/utils/query-date-expand.ts` | New helper | ~80 LOC |
| `src/modules/self-learning.ts` | +1 import, +5 lines, 2 call-site replacements | +8 LOC |
| `test/utils/query-date-expand.test.ts` | New unit tests | ~120 LOC, 14 cases |
| `test/modules/self-learning-date-expand.test.ts` | New integration tests | ~150 LOC, 6 cases |

No DB schema changes. No config changes. No chat.ts changes.

---

## §7. Constraints

- ASCII single quotes only in all source and test files
- No smart quotes
- `\b` word-boundary guards prevent partial matches inside longer numeric strings (phone numbers, order IDs)
- Regex compiled at module level (not inside function) — no per-call overhead
- Helper is pure / stateless — no logger dependency; logging sits in the caller (self-learning.ts)
