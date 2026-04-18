# Design Spec: Path A Narrow SQL Shortcut

## 1. API Surface

```typescript
// Location: src/storage/db.ts — ILearnedFactsRepository interface

/**
 * Returns all active facts for a group whose topic exactly matches one of the
 * 6 canonical topic prefixes for the given term. No LIMIT — result is bounded
 * by construction (at most 6 rows per term across all time).
 *
 * @param groupId  Group scope for the query.
 * @param term     Raw term string (e.g. "ygfn", "xtt"). Caller normalises
 *                 before passing (trim, lowercase optional — topics are
 *                 stored with the suffix exactly as taught/classified).
 * @returns        Array of LearnedFact rows, ORDER BY id DESC. Empty array
 *                 (never null, never throws) when no match.
 */
findActiveByTopicTerm(groupId: string, term: string): LearnedFact[];
```

Must be added to both `ILearnedFactsRepository` (interface) and `SqliteLearnedFactsRepository` (implementation).

---

## 2. SQL Text

```sql
SELECT *
FROM learned_facts
WHERE group_id = ?
  AND status = 'active'
  AND topic IN (?, ?, ?, ?, ?, ?)
ORDER BY id DESC
```

**Positional bindings (7 total, in order):**

| # | Value |
|---|-------|
| 1 | `groupId` |
| 2 | `user-taught:${term}` |
| 3 | `opus-classified:slang:${term}` |
| 4 | `opus-classified:fandom:${term}` |
| 5 | `opus-rest-classified:slang:${term}` |
| 6 | `opus-rest-classified:fandom:${term}` |
| 7 | `群内黑话:${term}` |

No LIMIT clause. Rows are bounded by construction — the IN set has exactly 6 members.

---

## 3. Topic Prefix Constant

**File:** `src/modules/fact-topic-prefixes.ts` (new file)

```typescript
export const FACT_TOPIC_PREFIXES = [
  'user-taught',
  'opus-classified:slang',
  'opus-classified:fandom',
  'opus-rest-classified:slang',
  'opus-rest-classified:fandom',
  '群内黑话',
] as const;

export type FactTopicPrefix = typeof FACT_TOPIC_PREFIXES[number];

/** Build the 6 exact topic strings for a given term. */
export function topicStringsForTerm(term: string): [string, string, string, string, string, string] {
  return FACT_TOPIC_PREFIXES.map(p => `${p}:${term}`) as [string, string, string, string, string, string];
}
```

Both `findActiveByTopicTerm` (db.ts) and `shouldAcceptFactCandidate` (fact-candidate-validator.ts) must import from this module — no string duplication.

---

## 4. insertOrSupersede Protection Logic

Current implementation at `src/storage/db.ts:1912` uses a LIKE-based match on `canonical_form`/`fact`, which is too broad and does not respect source authority.

**New pseudocode:**

```
function insertOrSupersede(row, termToSupersede):
  term = termToSupersede.trim()
  if term.length < 3:
    return { newId: insert(row), supersededCount: 0 }

  groupId = row.groupId
  isUserTaught = row.topic?.startsWith('user-taught:') ?? false

  BEGIN IMMEDIATE
    if isUserTaught:
      -- supersede ALL active rows matching term (existing behaviour)
      UPDATE learned_facts
        SET status = 'superseded', updated_at = now
        WHERE group_id = groupId
          AND status = 'active'
          AND (canonical_form LIKE '%{term}%' OR fact LIKE '%{term}%')

    else:
      -- supersede only non-user-taught active rows matching term
      UPDATE learned_facts
        SET status = 'superseded', updated_at = now
        WHERE group_id = groupId
          AND status = 'active'
          AND NOT topic LIKE 'user-taught:%'
          AND (canonical_form LIKE '%{term}%' OR fact LIKE '%{term}%')

    newId = insert(row)
  COMMIT
  return { newId, supersededCount }
```

The 50-row guard remains unchanged (checked before the BEGIN IMMEDIATE).
The only change is the UPDATE WHERE clause — adds `AND NOT topic LIKE 'user-taught:%'` when the incoming row is not user-taught.

---

## 5. Miner Filter Function

**File:** `src/modules/fact-candidate-validator.ts` (new file)

```typescript
export interface FactCandidateInput {
  canonical: string;       // canonical_form / canonical_fact text
  topic: string | null;    // constructed topic string (e.g. "群内梗 ygfn的意思")
  term: string;            // the term being inserted (used for user-taught check)
  groupId: string;         // for DB lookup of existing user-taught rows
  existingActiveRows: LearnedFact[]; // already-fetched active rows for this term
}

export interface FactCandidateResult {
  accept: boolean;
  rejectReason?: string;
}

export function shouldAcceptFactCandidate(input: FactCandidateInput): FactCandidateResult
```

**Rejection rules (evaluated in order; first match rejects):**

### Rule 1 — Existing user-taught fact blocks all non-user-taught candidates
```
if existingActiveRows.some(r => r.topic?.startsWith('user-taught:'))
  AND NOT input.topic?.startsWith('user-taught:')
→ reject: 'existing user-taught fact for term — non-user-taught candidate blocked'
```

### Rule 2 — Confusion pattern without definitive marker
```
CONFUSION_RE = /询问|问|不知道|含义不明|不清楚|是啥|是谁|啥意思|什么意思|新梗|可能|推测|表明/
DEFINITION_RE = /=|即|指|就是|缩写为|全名是|CV=|中文名/

if CONFUSION_RE.test(canonical) AND NOT DEFINITION_RE.test(canonical)
→ reject: 'confusion pattern in canonical without definitive marker'
```

### Rule 3 — 群内梗 topic + speaker-as-subject + no definition verb
```
SPEAKER_SUBJECT_RE = /^(西瓜|风平浪静|[^\s]+)[🍉\s]*(多次|曾经|反复|一直|总|又)?(询问|问过|不知道|搞不清)/
DEFINITION_VERB_RE = /=|即|指|就是|缩写为|全名是/

if topic?.startsWith('群内梗')
  AND SPEAKER_SUBJECT_RE.test(canonical)
  AND NOT DEFINITION_VERB_RE.test(canonical)
→ reject: '群内梗 topic with speaker-as-subject confusion pattern'
```

**Accept rule (overrides rules 2 and 3):**
If `DEFINITION_RE.test(canonical)` is true AND `CONFUSION_RE` also matches, definitive marker wins — accept. (Rule 1 still applies regardless.)

**Logging:** every rejection must call `logger.info({ groupId, term, canonical: canonical.slice(0, 80), rejectReason }, 'fact-candidate rejected')` at info level.

---

## 6. Call Sites to Gate

All locations where a fact is inserted (insert or insertOrSupersede). The rejection filter (`shouldAcceptFactCandidate`) applies only to miner-originated candidates — not to user-taught or online-research paths.

| File | Line | Method | Apply filter? | Notes |
|------|------|--------|--------------|-------|
| `src/modules/opportunistic-harvest.ts` | 366 | `learnedFacts.insert` | **YES** | Primary self-poisoning site. Gate before the insert call. |
| `src/modules/jargon-miner.ts` | 387 | `learnedFacts.insertOrSupersede` | **YES** | Miner-originated; apply filter before calling insertOrSupersede. |
| `src/modules/alias-miner.ts` | 229 | `learnedFacts.insert` | NO | Alias miner inserts aliases (e.g. user display names), not semantic facts — filter not applicable. |
| `src/modules/self-learning.ts` | 247 | `learnedFacts.insertOrSupersede` | NO | Correction fact from user in-chat correction — user-authoritative. |
| `src/modules/self-learning.ts` | 294 | `learnedFacts.insertOrSupersede` | NO | Passive harvest from followup messages — already gated by distillation. |
| `src/modules/self-learning.ts` | 724 | `learnedFacts.insertOrSupersede` | NO | Online research result — grounding-verified; do not filter. |
| `src/modules/on-demand-lookup.ts` | 243 | `learnedFacts.insertOrSupersede` | NO | FTS-inferred fact from on-demand path — not miner-generated. |

For the two YES sites, the filter must receive `existingActiveRows` pre-fetched for the candidate's term before the gate call. In `opportunistic-harvest.ts`, the existing `existing` array (line 290) is already in scope but is fetched with `listActive(groupId, 1000)` — this should be replaced or supplemented with a term-specific lookup for the gate check (use `findActiveByTopicTerm` when term is extractable from the topic string).

---

## 7. Test Cases

### `test/on-demand-lookup.test.ts`

| Input | Setup | Expected |
|-------|-------|----------|
| `lookupTerm(groupId, 'xtt', userId)` | DB has 600 active facts; `user-taught:xtt` fact has `created_at` = oldest (position 601 in DESC order) | Returns fact content; proves no 500-row cutoff |
| `lookupTerm(groupId, 'tt', userId)` | DB has `user-taught:xtt` and `user-taught:tt` | Returns `user-taught:tt` content only; `xtt` not returned (exact prefix match) |
| `lookupTerm(groupId, 'ygfn', userId)` | DB has both `user-taught:ygfn` (id=100) and `opus-classified:slang:ygfn` (id=200) | Returns `user-taught:ygfn` content (priorityRank=0 wins) |
| `lookupTerm(groupId, 'unknown', userId)` | No active facts for term | Falls through to FTS path (no shortcut hit) |

### `test/db-learned-facts.test.ts`

| Input | Setup | Expected |
|-------|-------|----------|
| `findActiveByTopicTerm(groupId, 'ygfn')` | One row each for all 6 topic prefixes, all active | Returns all 6 rows |
| `findActiveByTopicTerm(groupId, 'ygfn')` | `opus-classified:slang:ygfn` row exists but status='inactive' | Returns 5 rows (inactive excluded) |
| `findActiveByTopicTerm(groupId, 'ygfn')` | Only `user-taught:ygfn` active | Returns 1 row |
| `findActiveByTopicTerm(groupId, 'absent')` | No rows for term | Returns empty array (not null, not error) |
| `findActiveByTopicTerm(groupId, 'tt')` | `user-taught:xtt` active, `user-taught:tt` active | Returns only `user-taught:tt` — exact topic match, substring not included |
| `findActiveByTopicTerm(groupId, 'ygfn')` | Rows in different groupId | Returns empty (group_id scoped) |

### `test/db-insert-supersede.test.ts`

| Input | Setup | Expected |
|-------|-------|----------|
| `insertOrSupersede({topic:'opus-classified:slang:ygfn', ...}, 'ygfn')` | `user-taught:ygfn` active (id=1), `opus-classified:slang:ygfn` active (id=2) | id=1 stays active; id=2 superseded; new row inserted active |
| `insertOrSupersede({topic:'user-taught:ygfn', ...}, 'ygfn')` | `user-taught:ygfn` active (id=1), `opus-classified:slang:ygfn` active (id=2) | Both id=1 and id=2 superseded; new user-taught row inserted active |
| `insertOrSupersede({topic:'opus-classified:fandom:ygfn', ...}, 'ygfn')` | No existing rows | New row inserted active; supersededCount=0 |
| `insertOrSupersede({topic:'user-taught:ygfn', ...}, 'ygfn')` | Two `user-taught:ygfn` rows active (id=1, id=2) | Both superseded; new user-taught becomes sole active |

### `test/opportunistic-harvest.test.ts`

| Input | Setup | Expected |
|-------|-------|----------|
| Candidate `{canonical:'西瓜多次询问ygfn是谁，表明ygfn是群内不明缩写', topic:'群内梗 ygfn的意思'}` | No user-taught rows | Rejected; reason matches confusion pattern rule |
| Candidate `{canonical:'ygfn=羊宫妃那', topic:'群内梗 ygfn'}` | No user-taught rows | Accepted; definitive marker present |
| Candidate `{canonical:'ygfn可能是羊宫妃那的缩写', topic:'群内梗 ygfn'}` | No user-taught rows | Rejected; `可能` + no definitive marker |
| Candidate `{canonical:'ygfn=羊宫妃那，西瓜也问过', topic:'群内梗 ygfn'}` | No user-taught rows | Accepted; `=` overrides confusion keyword |
| Candidate `{canonical:'xtt是小团体', topic:'群内梗 xtt'}` | `user-taught:xtt` active in DB | Rejected; existing user-taught blocks non-user-taught |
| Candidate `{canonical:'xtt=小团体，波士顿的', topic:'群内梗 xtt'}` | `user-taught:xtt` active in DB | Rejected; Rule 1 applies regardless of definition marker |
| Any candidate with jailbreak pattern | — | Rejected by existing jailbreak gate (pre-existing behaviour, no regression) |

---

## 8. Rollback Plan

**What changed in miner behaviour:**
- `opportunistic-harvest.ts` and `jargon-miner.ts` now reject candidates that previously inserted.
- Every rejection is logged at info level with `rejectReason`.

**How to detect false rejections (valid facts wrongly filtered):**

1. Monitor `fact-candidate rejected` log entries in the first 30 minutes post-deploy. Any entry with `rejectReason: 'confusion pattern'` where the canonical clearly contains a definition (`=`, `即`, `就是`) indicates a regex bug in Rule 2 — check DEFINITION_RE coverage.

2. Watch for `rejectReason: 'existing user-taught fact for term'` entries where the blocked candidate would have been higher-quality than the existing user-taught fact. This rule is intentional (user-taught is authoritative) — but if users complain that a bot "knows something wrong", the admin should update the user-taught fact directly rather than softening the filter.

3. If false positive rate is high (e.g. >20% of previously-accepted miner facts now rejected in a test replay), the confusion keyword set (`询问|问|...`) is too broad. Narrow by requiring the confusion keyword to appear in the **first 10 characters** of canonical rather than anywhere in the string.

4. The `jargon-miner.ts` path (`insertOrSupersede` at line 387) is lower volume; false positives there are easier to spot since jargon-miner candidates already go through Grounding verification — a valid fact rejected here will also surface as a missing jargon entry on next lookup.

**Revert path:** Remove the `shouldAcceptFactCandidate` gate call from the two call sites (opportunistic-harvest line 366, jargon-miner line 387). No schema changes, no data migration needed. The `fact-candidate-validator.ts` module can remain dead until re-enabled.
