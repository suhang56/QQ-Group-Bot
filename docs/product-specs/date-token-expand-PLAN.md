# Feature: Date Token Query Expansion (Pre-BM25 Rewrite)

## 1. Goal

When a user query contains compact date tokens ('618', '6/18', '6-18'), expand
them to canonical Chinese forms ('6月18号', '6月18日', '6月') BEFORE BM25 and
vector retrieval, so the system matches DB facts that were stored in canonical
form.

Live failure evidence (#8347, 2026-05-05):
- Query '618附近有哪些live' returned 20 fandom-term facts, missed id=2694 and
  id=2841 which use '6月' in their text.
- Bot answer was hallucinated from recent_history echo, not from facts.

Root cause: '618' has no overlap with '6月' in FTS5 trigram tokenization, so
BM25 gives it zero score on those rows.

---

## 2. Detection Patterns (what to expand)

A substring in the query is a candidate date token if it matches ONE of:

| Pattern form       | Regex                  | Example matches          |
|--------------------|------------------------|--------------------------|
| 3-digit MMD        | `\b([1-9])(0[1-9]|[12]\d|3[01])\b` | '618' → month=6 day=18  |
| 4-digit MMDD       | `\b(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b` | '0618', '1231'          |
| Slash form         | `\b([1-9]\d?)/([1-9]\d?)\b` | '6/18', '12/31'         |
| Dash form          | `\b([1-9]\d?)-([1-9]\d?)\b` | '6-18', '12-1'          |
| Chinese digit form | `[一二三四五六七八九十]{1,2}月` already canonical, no expand |

Month must satisfy 1-12, day must satisfy 1-31 — values outside range are
NOT treated as dates. Exact boundary validation is done in the helper after
extraction.

Chinese digit sequences such as '六一八' or '十二月三十一' are explicitly
deferred to a later iteration — small subset, higher parsing complexity.

---

## 3. Expansion Targets (what tokens to append)

For a recognized date token with extracted month M and day D:

1. `{M}月{D}号`   (most common written form in group chat)
2. `{M}月{D}日`   (formal written form)
3. `{M}月`        (month-only fallback — matches facts that cite the month
                   without specifying day, e.g. id=2694, id=2841)

No year prefix is added. The expansion is neutral across years. If the DB has
English-form entries ('June 18') that is a future concern — not observed.

The expanded tokens are appended to the query string with spaces:
  '618附近有哪些live' → '618附近有哪些live 6月18号 6月18日 6月'

The original tokens are preserved so existing BM25 scores for non-date terms
are unaffected.

---

## 4. Integration Point

**File:** `src/modules/self-learning.ts`, inside `formatFactsForPrompt`.

**Where:** Immediately before the BM25 and vector calls (current line ~449),
rewrite `triggerText` to an expanded string:

  const expandedTrigger = expandDateTokens(triggerText);

Then use `expandedTrigger` in:
- `searchByBM25(groupId, expandedTrigger, BM25_TOP_K)` (line ~450)
- `svc.embed(expandedTrigger)` (line ~436) — replaces `triggerText`

The expansion is purely additive: it appends tokens, never removes. The caller
`chat.ts:2793-2795` does not change.

---

## 5. Out of Scope

- Year-aware expansion ('618' could be any year; just add neutral '6月18号')
- Constraint extraction beyond date ('5月后', '之前', range queries) — that is
  the R9 constraint layer, a separate workstream
- Chinese digit numeral parsing ('六一八', '十二月') — defer
- Vector embedding strategy change — the expanded string naturally feeds into
  svc.embed too; no architectural change needed
- Reverse direction: DB normalization is out of scope; fix only the query side

---

## 6. Edge Cases to Test

| Input                  | Expected expansion                    | Rationale                                  |
|------------------------|---------------------------------------|--------------------------------------------|
| '618附近有哪些live'    | append '6月18号 6月18日 6月'          | Primary motivating case                    |
| '0618的活动'           | append '6月18号 6月18日 6月'          | 4-digit leading-zero form                  |
| '6/18有live吗'         | append '6月18号 6月18日 6月'          | Slash form                                 |
| '6-18'                 | append '6月18号 6月18日 6月'          | Dash form                                  |
| '1231跨年'             | append '12月31号 12月31日 12月'       | Month=12 day=31, boundary valid            |
| '1300' (invalid hour)  | no expansion — month 13 out of range  | Guard: month > 12 rejected                 |
| '911'                  | no expansion — day=11 month=9 valid   | Treated as date; appends '9月11号 ...'     |
|                        |                                       | BM25 will simply find no matches — OK      |
| '404'                  | no expansion — day=4 month=4 valid    | Same as above; harmless false positive      |
| '13800138000'          | no expansion — 11 digits, >= 5 digits | Phone number guard: only 3-4 digit forms   |
| '已知6月18号的活动'    | already canonical, no duplicate added | Canonical form present; no expand needed   |
| '618 619 620'          | expand each independently             | Multiple date tokens in one query           |
| '6/18 12/31'           | expand both                           | Two slash forms                             |
| '6月18号有live吗'      | no expansion (already canonical)      | Detect canonical form, skip expansion       |

---

## 7. Files Touched Estimate

| File                                                   | Change type |
|--------------------------------------------------------|-------------|
| `src/utils/query-date-expand.ts`                       | New helper  |
| `src/modules/self-learning.ts`                         | 3-5 lines   |
| `test/utils/query-date-expand.test.ts`                 | New tests   |
| `test/modules/self-learning-date-expand.test.ts`       | New integration tests |

No DB schema changes. No config changes. No chat.ts changes.

---

## 8. Open Questions for Designer / Architect

1. **Canonical form skip:** If query already contains '6月18号' or '6月18日',
   should we skip adding duplicate tokens? Probably yes — avoid BM25 query bloat.
   Architect to decide threshold.

2. **Token cap:** If a query has 5+ date tokens (edge: someone pastes a concert
   schedule), should we cap expansions to avoid FTS query length limits?
   Suggest cap = 3 date tokens expanded, rest ignored.

3. **BM25 FTS sanitization:** `sanitizeFtsQuery` is called inside `searchByBM25`.
   Confirm expanded tokens (ASCII digits + Chinese chars) survive sanitization
   without being stripped. Architect to verify.

4. **Vector embed benefit:** Embedding the expanded string vs original string for
   vector retrieval — is the delta worth the token overhead? Low risk to always
   expand both, but architect can choose to expand BM25-only and leave embed on
   original.

5. **Logging:** Should the helper log which tokens were expanded and the
   resulting expanded query? Useful for debugging future misses. Suggest debug
   level only.
