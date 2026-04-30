# Spec: Fix fact-retrieval alias gap (fact-needed-no-fact)

## Bug Summary

R7 benchmark (PR #152, 781 rows) surfaced 16 cases (2.0%) tagged `fact-needed-no-fact`:
bot was @-mentioned with a question containing a known group alias (e.g. `ygfn`, `拉神`),
the DB had a matching `user-taught:ygfn` fact, yet `matchedFactIds` was empty and the
`hasFactTerm` signal was false. Bot answered without fact context.

---

## Root Cause Diagnosis

### Where `_hasKnownFactTermPreview` is defined and what it checks

**File**: `src/core/router.ts:1193`

```
_hasKnownFactTermPreview(groupId, content):
  cands = extractCandidateTerms(content).filter(isValidStructuredTerm).slice(0, 3)
  for term in cands:
    if db.learnedFacts.findActiveByTopicTerm(groupId, term).length > 0 → return true
  return false
```

This is an **input-classifier preview** used by the Router to pre-score `hasKnownFactTerm`
before dispatching to ChatModule. It does an exact `topic IN (...)` DB lookup using
`topicStringsForTerm(term)`, which builds strings like `user-taught:ygfn`.

**Detection scope**: Correctly finds `ygfn` IF `extractCandidateTerms` yields `"ygfn"` as
a candidate from the trigger text.

### How `extractCandidateTerms` processes the failing queries

**File**: `src/utils/extract-candidate-terms.ts`

Two passes:
1. **CJK suffix regex** (`CJK_QUERY_SUFFIX_RE`): only fires when the ENTIRE content matches
   `^(\p{Script=Han}{2,10})(是谁|怎么样|如何|...)$`. Requires **pure-Han** leading term.
   - `"ygfn是谁"` → FAILS this pass (Latin prefix, not Han).
   - `"拉神是谁"` → succeeds (if `拉神` ≤ 10 Han chars with no dirty suffixes).
2. **Tokenizer fallback** (`extractTokens` + scaffolding filter): splits by CJK/ASCII
   boundaries. For `"如何评价ygfn"`:
   - tokens: `["如何评价", "ygfn"]`
   - `"如何评价"` → filtered as scaffolding (`QUESTION_SCAFFOLDING_TOKEN_RE`)
   - `"ygfn"` → passes `isValidStructuredTerm` (Case 1: ASCII-leading)
   - **Result: `["ygfn"]` — extraction IS correct.**

For `"你觉得拉神怎么样"`:
   - tokens: `["你觉得", "拉神", "怎么样"]`
   - `"你觉得"` → filtered as scaffolding
   - `"拉神"` → passes `isValidStructuredTerm` (Case 3: pure-Han 2 chars)
   - `"怎么样"` → filtered as scaffolding
   - **Result: `["拉神"]` — extraction IS correct.**

**Conclusion: `extractCandidateTerms` is not the bug.**

### The actual gap: `matchedFactRetrievalIds` does NOT include Path A hits

**File**: `src/modules/chat.ts:2699`

```
matchedFactRetrievalIds  ←  formatFactsForPrompt(groupId, 50, triggerText)
                                    → BM25 (FTS5 over canonical_form / fact text)
                                    + semantic vector cosine similarity
                                    → RRF fuse → matchedFactIds
```

`matchedFactRetrievalIds` is populated **only** by hybrid BM25+vector retrieval inside
`formatFactsForPrompt` (self-learning.ts:359).

Path A (on-demand-lookup) runs at **chat.ts:2063**, BEFORE `formatFactsForPrompt`, using
`findActiveByTopicTerm` (exact topic match). When Path A's shortcut hits `ygfn`, it injects
the fact text into the system prompt via `onDemandFactBlock`. BUT this hit is **never
reflected in `matchedFactRetrievalIds`**.

`hasKnownFactTerm` at chat.ts:2724:
```
hasKnownFactTerm = matchedFactRetrievalIds.length > 0 || factsBlockHasRealHit
```

If BM25 fails to tokenize the short Latin alias `ygfn` as a meaningful FTS5 token (SQLite
FTS5 default tokenizer does NOT split on 2-4 char ASCII — depends on porter/unicode61
config), the BM25 hit is zero. Vector may hit if embedding is trained on the alias, but
is not guaranteed. Result: `matchedFactIds = []`, `hasKnownFactTerm = false`, benchmark
tags it `fact-needed-no-fact`.

### Why the Router's preview also fails for some cases

Router preview at `router.ts:1197` uses `_hasKnownFactTermPreview` which calls
`findActiveByTopicTerm`. This SHOULD return true when `ygfn` is extracted correctly.
However the router-level `hasKnownFactTerm` is a **pre-dispatch** signal — it affects
engagement gating (engagement-decision.ts:285 upgrades strength to generate if
`hasKnownFactTerm = true`). If this preview is false (rare case where extraction misses),
the message could be `react`-gated before reaching `generateReply`.

Most failing rows ARE direct @-mentions (direct path bypasses engagement gating), so the
router preview gap is secondary. The primary gap is the `matchedFactRetrievalIds`
accounting gap described above.

### Summary of two failure modes

| # | Where | What fails | Effect |
|---|-------|-----------|--------|
| 1 | `self-learning.ts:formatFactsForPrompt` | BM25/vector don't score short Latin aliases high enough (FTS5 tokenizer / low cosine) → `matchedFactIds = []` | `hasKnownFactTerm=false` in benchmark even though Path A injected the fact |
| 2 | `router.ts:_hasKnownFactTermPreview` | Only called at router pre-dispatch; not wired into the benchmark `hasFactTerm` signal | Router preview=true doesn't help if benchmark reads chat.ts:2724 |

---

## Proposed Fix Scope

### Fix 1 (primary): merge Path A hits into `matchedFactRetrievalIds`

`_buildOnDemandBlock` returns `foundTerms: ReadonlySet<string>` — terms for which
`lookupTerm` returned `type='found'`. Each `found` outcome means a `learned_facts` row
was hit via `findActiveByTopicTerm`. The IDs of those rows should be merged into
`matchedFactRetrievalIds` so `hasKnownFactTerm` at chat.ts:2724 reflects Path A hits.

Deliverable: `_buildOnDemandBlock` returns an additional `foundFactIds: number[]`.
`metaBuilder.setFactIds` receives the union of BM25/vector IDs and Path A IDs.
`matchedFactRetrievalIds` union includes Path A hits.

### Fix 2 (secondary): widen BM25 retrieval to include topic-term exact matches

When `extractCandidateTerms` yields structured terms (passes `isValidStructuredTerm`),
run `findActiveByTopicTerm` inside `formatFactsForPrompt` (or a pre-pass before BM25)
and include those rows in the `fused` set, marked as retrieval hits. This ensures
short Latin aliases like `ygfn` survive as `matchedFactIds` even if BM25 tokenizer misses.

### Fix 3 (optional, lowest priority): widen CJK suffix regex for mixed-script

`CJK_QUERY_SUFFIX_RE` only handles pure-Han leading terms. Consider adding a regex for
`"(Latin)\s*(是谁|怎么样|如何)"` to improve CJK_QUERY_SUFFIX_RE coverage for cases
where the tokenizer might not split the query correctly. Low priority since the tokenizer
fallback already handles `"ygfn是谁"` correctly.

---

## Negative Cases: Must NOT Over-Trigger

- `"ygfn今天也来了"` (casual mention, no question pattern) → fact retrieval optional; do not force `hasKnownFactTerm=true` for every alias occurrence
- `"大家觉得怎么样"` (no structured term, pure scaffolding) → no fact retrieval
- `"我觉得ygfn很厉害"` (declarative, not a question or evaluation-ask) → fact retrieval optional, not forced
- `"今天天气不错"` → no alias, no retrieval
- Any message where `extractCandidateTerms` returns empty → no change

Fix 1 only triggers when Path A **already ran and found** a fact — it just propagates
the existing hit into the accounting signal. It cannot over-trigger.

Fix 2 only adds rows to the BM25+vector fused set if `findActiveByTopicTerm` returns
non-empty — same term gate as existing code.

---

## Acceptance Criteria

- [ ] `"ygfn是谁"` (direct @-mention) → `matchedFactIds` non-empty, `hasKnownFactTerm=true`
- [ ] `"如何评价ygfn"` → same
- [ ] `"你觉得拉神怎么样"` → same
- [ ] `"你是不是暗恋ygfn"` (reply+at) → same
- [ ] `"今天天气不错"` → `matchedFactIds=[]`, `hasKnownFactTerm=false`
- [ ] `"ygfn今天也来了"` (statement) → `hasKnownFactTerm` unchanged from current behavior (acceptable if true, must not be false-negative on question paths)
- [ ] R7 benchmark `fact-needed-no-fact` count drops from 16 to ≤4 (75% reduction)
- [ ] No regression on `fact-not-needed-has-fact` count (over-trigger)

---

## Test Cases

```
input: "[CQ:at,qq=BOT] ygfn是谁"
expected: matchedFactIds includes fact id for user-taught:ygfn

input: "[CQ:at,qq=BOT] 如何评价ygfn"
expected: matchedFactIds includes fact id for user-taught:ygfn

input: "[CQ:reply,...][CQ:at,qq=BOT] 你觉得拉神怎么样"
expected: matchedFactIds includes fact id for 群友别名:拉神 or user-taught:拉神

input: "[CQ:at,qq=BOT] 今天天气不错"
expected: matchedFactIds=[], hasKnownFactTerm=false
```

---

## Iteration Contract

| Artifact | File | Change type |
|----------|------|-------------|
| `_buildOnDemandBlock` return type | `src/modules/chat.ts:4369` | Add `foundFactIds: number[]` to return |
| `_buildOnDemandBlock` body | `src/modules/chat.ts:4388` | Collect fact IDs when `lookupTerm` shortcut hits |
| `lookupTerm` shortcut | `src/modules/on-demand-lookup.ts:89` | Return fact ID alongside `found` outcome OR expose via separate field |
| `matchedFactRetrievalIds` assembly | `src/modules/chat.ts:2699` | Union with Path A fact IDs |
| Pre-pass in `formatFactsForPrompt` | `src/modules/self-learning.ts:359` | Optional: run `findActiveByTopicTerm` for structured terms before BM25 |
| Tests | `test/modules/chat.test.ts` or `test/modules/self-learning.test.ts` | Add alias-query → matchedFactIds cases |

Estimated line delta: ~40-80 lines modified across 3 files (chat.ts, on-demand-lookup.ts, self-learning.ts).

---

## Open Questions for Architect/Developer

1. Should `TermLookupOutcome` include `factId?: number` on the `found` type, or should
   `lookupTerm` return the full `LearnedFact` when hitting the shortcut?
2. Should Fix 2 (exact-topic pre-pass) live inside `formatFactsForPrompt` or as a
   separate helper called by the caller before `formatFactsForPrompt`?
3. Is there a risk that adding shortcut fact IDs to `matchedFactIds` changes the
   `pinnedOnly` flag semantics? (Current: `pinnedOnly = matchedIds.length === 0 && injected > 0`)
