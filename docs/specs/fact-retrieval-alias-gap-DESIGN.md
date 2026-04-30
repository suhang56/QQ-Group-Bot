# DESIGN: fact-retrieval alias gap fix

---

## Open Question Resolution: TermLookupOutcome shape

**Decision: add `factId?: number` to the `found` variant only.**

Rationale:
- Full `LearnedFact` row return would bloat the interface, expose implementation details to chat.ts, and couple on-demand-lookup.ts to storage types beyond what it already imports.
- `factId` alone is the only field needed downstream (union into `matchedFactRetrievalIds`).
- The shortcut path at on-demand-lookup.ts:104 already has `match.id` in scope — trivial to attach.
- The LLM-cache path at on-demand-lookup.ts:165 does NOT have a fact ID readily available (insert is fire-and-forget via `_cacheFact`); for freshly cached facts the ID is unknown without a second DB read. Decision: return `factId: undefined` for the LLM-cache `found` path; only shortcut hits populate it. This is safe because LLM-cache hits mean BM25/vector will find the row on next call anyway.

```ts
export type TermLookupOutcome =
  | { type: 'found'; meaning: string; factId?: number }  // factId set on shortcut hits only
  | { type: 'weak'; guess: string }
  | { type: 'unknown' };
```

---

## Fix 1 (primary): propagate Path A shortcut hit IDs into matchedFactRetrievalIds

### Part 1a — on-demand-lookup.ts: attach factId on shortcut hit

**File**: `src/modules/on-demand-lookup.ts`
**Lines affected**: ~108 (shortcut return)

```ts
// BEFORE (line 108):
return { type: 'found', meaning };

// AFTER:
return { type: 'found', meaning, factId: match.id };
```

Type change only on the `found` discriminant (see Open Question above). No other change to `lookupTerm`.

### Part 1b — chat.ts: collect foundFactIds from _buildOnDemandBlock

**File**: `src/modules/chat.ts`
**Lines affected**: `_buildOnDemandBlock` return type (~4373) + body (~4388-4394) + caller (~2063)

Return type change:
```ts
// BEFORE:
): Promise<{ block: string; foundTerms: ReadonlySet<string> }>

// AFTER:
): Promise<{ block: string; foundTerms: ReadonlySet<string>; foundFactIds: ReadonlyArray<number> }>
```

Body change inside the `outcome?.type === 'found'` branch:
```ts
// Add at top of _buildOnDemandBlock body:
const foundFactIds: number[] = [];

// BEFORE (inside found branch, ~line 4392):
foundTerms.add(term);

// AFTER:
foundTerms.add(term);
if (outcome.factId != null) foundFactIds.push(outcome.factId);
```

Early-return paths need the new field too:
```ts
// BEFORE (two early returns at ~4374 and ~4382):
return { block: '', foundTerms: new Set() };

// AFTER:
return { block: '', foundTerms: new Set(), foundFactIds: [] };
```

Final return:
```ts
// BEFORE (~4435):
return { block, foundTerms };

// AFTER:
return { block, foundTerms, foundFactIds };
```

### Part 1c — chat.ts: union foundFactIds into matchedFactRetrievalIds

**File**: `src/modules/chat.ts`
**Lines affected**: ~2063 (destructure) and ~2699-2706 (assembly)

Caller destructure:
```ts
// BEFORE (~2063):
const { block: onDemandFactBlock, foundTerms: onDemandFoundTerms } = await this._buildOnDemandBlock(...)

// AFTER:
const { block: onDemandFactBlock, foundTerms: onDemandFoundTerms, foundFactIds: onDemandFoundFactIds } = await this._buildOnDemandBlock(...)
```

matchedFactRetrievalIds union (~2699-2706):
```ts
// BEFORE:
const { text: factsBlock, injectedFactIds, matchedFactIds: matchedFactRetrievalIds, pinnedOnly: factsBlockPinnedOnly } =
  (await this.selfLearning?.formatFactsForPrompt(groupId, 50, triggerMessage.content))
  ?? { text: '', injectedFactIds: [], matchedFactIds: [], pinnedOnly: false };
metaBuilder.setFactIds(injectedFactIds, matchedFactRetrievalIds);

// AFTER:
const { text: factsBlock, injectedFactIds, matchedFactIds: bm25VectorMatchedIds, pinnedOnly: factsBlockPinnedOnly } =
  (await this.selfLearning?.formatFactsForPrompt(groupId, 50, triggerMessage.content))
  ?? { text: '', injectedFactIds: [], matchedFactIds: [], pinnedOnly: false };
const matchedFactRetrievalIds = [
  ...bm25VectorMatchedIds,
  ...onDemandFoundFactIds.filter(id => !bm25VectorMatchedIds.includes(id)),
];
metaBuilder.setFactIds(injectedFactIds, matchedFactRetrievalIds);
```

Note: `pinnedOnly` semantics are unchanged. `pinnedOnly = matchedIds.length === 0 && injected > 0` in self-learning.ts reads `bm25VectorMatchedIds` (formatFactsForPrompt internal) not the union. This is correct — `pinnedOnly` describes the BM25/vector RAG path state; Path A is a separate injection mechanism. No semantic regression.

---

## Fix 2 (secondary): structured-term exact pre-pass in formatFactsForPrompt

**Decision: implement as an inline pre-pass inside `formatFactsForPrompt`, NOT a separate helper.**

Rationale: keeps the `FormattedFacts` return contract untouched for all callers; the pre-pass IDs naturally merge into `matchedIdSet` before the existing `fused` merge, minimizing diff surface.

**File**: `src/modules/self-learning.ts`
**Lines affected**: ~359-435 (`formatFactsForPrompt` body)

Insert after `triggerText.length === 0` guard, before BM25/vector parallel block:

```ts
// Structured-term exact pre-pass: for short Latin aliases (e.g. 'ygfn', 'hyw')
// that FTS5 may miss, run findActiveByTopicTerm for each candidate structured term.
// Results merge into fused set so matchedFactIds includes them even when BM25=0.
const exactPrePassIds = new Set<number>();
const exactPrePassFacts: LearnedFact[] = [];
{
  const candidates = extractCandidateTermsForFacts(triggerText);
  for (const term of candidates) {
    const rows = this.db.learnedFacts.findActiveByTopicTerm(groupId, term);
    for (const row of rows) {
      if (!exactPrePassIds.has(row.id)) {
        exactPrePassIds.add(row.id);
        exactPrePassFacts.push(row);
      }
    }
  }
}
```

Then merge into `fused` after RRF:
```ts
// BEFORE:
const fused = rrfFuse<LearnedFact>([...], ...);

// AFTER:
const rrfFused = rrfFuse<LearnedFact>([...], ...);
// Prepend exact pre-pass hits not already in RRF output.
const rrfFusedIds = new Set(rrfFused.map(r => r.item.id));
const prePassOnly = exactPrePassFacts.filter(f => !rrfFusedIds.has(f.id));
const fused = [
  ...rrfFused,
  ...prePassOnly.map(f => ({ item: f, score: 0, contributions: [] })),
];
```

`matchedIdSet` at line 481 is built from `fused.map(r => r.item.id)` — pre-pass hits are now included automatically.

### Edge decision: all messages vs direct/at-bot only for the pre-pass

**Decision: pre-pass fires on ALL messages that reach `formatFactsForPrompt`**, not just direct/@-bot.

Rationale:
- `formatFactsForPrompt` is already gated by the caller (chat.ts:2700) which only runs inside `generateReply`. The engagement gating upstream already decided this message warrants a reply.
- Filtering inside `formatFactsForPrompt` by "is this direct/at" would require passing a new param and adds complexity.
- Over-trigger risk is low: `findActiveByTopicTerm` requires an exact topic match; casual mentions like "ygfn今天来了" still trigger the pre-pass but the result flows into `matchedFactRetrievalIds` (which is fine — fact context is available and correct).
- Spec section "Negative Cases" explicitly says "fact retrieval optional" for casual mentions — not "must be false". The `fact-not-needed-has-fact` benchmark signal measures whether the bot hallucinated absent context, not whether IDs were populated.

### extractCandidateTermsForFacts — helper needed?

`formatFactsForPrompt` currently does not import `extractCandidateTerms`. To avoid a new import coupling self-learning.ts to extract-candidate-terms.ts, use a **minimal inline filter** instead:

```ts
// Inline: extract candidate structured terms from triggerText without
// importing the full extractCandidateTerms pipeline.
// Only ASCII-leading (Latin alias) and 2-4 Han-char tokens qualify.
function extractCandidateTermsForFacts(text: string): string[] {
  // Split on CJK/ASCII/punctuation boundaries.
  const tokens = text.split(/[\s,，。！？!?、：:；;()\[\]【】""'']+/).filter(Boolean);
  return tokens.filter(t => isValidStructuredTerm(t)).slice(0, 5);
}
```

`isValidStructuredTerm` is already imported in self-learning.ts (check: it is used in `_dedupByTermTrust`). If not, import from `./fact-topic-prefixes.js`.

Performance: O(tokens) split + O(terms * DB-lookup). Term count bounded by `.slice(0, 5)`. `findActiveByTopicTerm` is a prepared statement O(1) index seek per term. Total overhead per message: negligible (≤5 DB reads, each sub-millisecond).

---

## Iteration Contract

| File | Change type | Estimated lines |
|------|-------------|----------------|
| `src/modules/on-demand-lookup.ts` | Type change on `found` discriminant + attach `factId` on shortcut return | ~3 lines |
| `src/modules/chat.ts` | `_buildOnDemandBlock` return type, body, early returns; caller destructure; matchedFactRetrievalIds union | ~20 lines |
| `src/modules/self-learning.ts` | Structured-term exact pre-pass inside `formatFactsForPrompt` | ~22 lines |
| `test/modules/chat.test.ts` or `test/modules/self-learning.test.ts` | New alias-query test cases | ~40 lines |

**Total**: 4 files changed, ~85 lines modified/added.

---

## Test Matrix

### Positive cases (must pass)

| # | Input (trigger) | Path | Expected |
|---|----------------|------|----------|
| P1 | `[CQ:at,qq=BOT] ygfn是谁` | Path A shortcut hit (user-taught:ygfn exists) + Fix 1 | `matchedFactRetrievalIds` includes `user-taught:ygfn` fact id; `hasKnownFactTerm=true` |
| P2 | `[CQ:at,qq=BOT] 如何评价ygfn` | Path A shortcut hit + Fix 1 | same as P1 |
| P3 | `[CQ:reply,...][CQ:at,qq=BOT] 你觉得拉神怎么样` | Path A shortcut hit (群友别名:拉神 or user-taught:拉神) + Fix 1 | `matchedFactRetrievalIds` includes `拉神` fact id |
| P4 | `[CQ:at,qq=BOT] hyw是谁` | Path A shortcut hit (user-taught:hyw) + Fix 1 | same as P1 |
| P5 | `[CQ:at,qq=BOT] 你觉得kdhr这个人怎么样` | Path A shortcut hit (user-taught:kdhr) + Fix 1 | `matchedFactRetrievalIds` includes `kdhr` fact id |
| P6 | BM25=0 for `ygfn`, Fix 2 pre-pass runs | `formatFactsForPrompt` pre-pass hits `user-taught:ygfn` | `matchedFactRetrievalIds` non-empty from pre-pass alone |
| P7 | BanG Dream lore term `Morfonica` (structured, BM25 hits) | BM25 hits + pre-pass both fire | `matchedFactRetrievalIds` includes both BM25 IDs and pre-pass IDs (deduped) |

### Negative cases (must NOT over-trigger)

| # | Input | Expected |
|---|-------|----------|
| N1 | `今天天气不错` | No alias extracted; `matchedFactRetrievalIds=[]`; `hasKnownFactTerm=false` |
| N2 | `大家觉得怎么样` | Pure scaffolding; `extractCandidateTerms` returns empty; no pre-pass; `matchedFactRetrievalIds=[]` |
| N3 | `我觉得ygfn很厉害` | Declarative; Path A runs (ygfn extracted), shortcut hits → `foundFactIds` includes id. `hasKnownFactTerm=true` is acceptable per spec ('optional, not forced to be false') |
| N4 | `ygfn今天也来了` | Same as N3 — acceptable if true; must not be false-negative on question paths |
| N5 | `你是不是暗恋ygfn` (no fact in DB) | No shortcut hit; Path A tries LLM path (rate-permitting); `foundFactIds=[]`; `matchedFactRetrievalIds=[]` |

### Edge cases

| # | Input | Expected |
|---|-------|----------|
| E1 | `我问你ygfn和hyw谁更厉害` | Two aliases extracted; both shortcut hit; `foundFactIds` has both IDs; `matchedFactRetrievalIds` union has both |
| E2 | `ygfn` (one-word message, direct @) | Single token; `isValidStructuredTerm` passes; shortcut hit → `matchedFactRetrievalIds` non-empty |
| E3 | Alias in DB under `ondemand-lookup:ygfn` (LLM-cached, not user-taught) | Shortcut still hits via `findActiveByTopicTerm` (topic prefix includes `ondemand-lookup:`); `factId` returned; union includes it |

---

## Summary

- Fix 1 is the primary fix: 3 files, minimal change, closes the accounting gap with no behavioral change.
- Fix 2 is additive safety net for BM25 tokenizer gaps on short Latin aliases: inline pre-pass, O(1) per term, no new imports needed.
- `TermLookupOutcome.found.factId?: number` — optional, shortcut-path only. LLM-cache path leaves it undefined (safe: those facts appear in next BM25 call).
- Pre-pass fires on all messages reaching `formatFactsForPrompt`; engagement gating upstream is the right gate, not an internal path flag.
- `pinnedOnly` semantics unchanged (self-learning.ts internal to BM25/vector RAG path).
