# DEV-READY: Path A Narrow SQL Shortcut

**Task #30** — Fix Path A shortcut + user-taught supersede protection + miner self-poisoning filter.

Sources of truth:
- Planner: `docs/product-specs/path-a-narrow-sql-shortcut.md` (M1–M7)
- Designer: `docs/specs/path-a-narrow-sql-DESIGN.md` (authoritative JSON shape, SQL, rules)

This document is the step-by-step implementable plan for Developer. **No code decisions here override Designer.**

---

## 1. File Creation / Edit Order

Compile-break free order. Each step leaves `tsc --noEmit` green.

1. **CREATE** `src/modules/fact-topic-prefixes.ts` — new file, no dependencies. Standalone.
2. **EDIT** `src/storage/db.ts` — add `findActiveByTopicTerm` to interface + impl; modify `insertOrSupersede` UPDATE clause.
3. **CREATE** `src/modules/fact-candidate-validator.ts` — imports from `fact-topic-prefixes.ts` (step 1) and `LearnedFact` type from `db.ts` (step 2).
4. **EDIT** `src/modules/on-demand-lookup.ts` — call new `findActiveByTopicTerm`. Drop old TOPIC_TERM_RE filter.
5. **EDIT** `src/modules/opportunistic-harvest.ts` — import + call validator before `insert`.
6. **EDIT** `src/modules/jargon-miner.ts` — import + call validator before `insertOrSupersede`.
7. **CREATE / EDIT** test files (step 9 below).
8. Run `npx tsc --noEmit` → must be clean.
9. Run `npm test` → all passing.

---

## 2. Exact File Changes

### 2.1 CREATE `src/modules/fact-topic-prefixes.ts`

```typescript
/**
 * The six canonical topic prefixes under which a learned_fact can be stored
 * for a given term. Every term-scoped lookup (findActiveByTopicTerm) and the
 * miner candidate validator import from here — single source of truth.
 *
 * Order matters only for debug readability; SQL IN clause is unordered.
 */
export const LEARNED_FACT_TOPIC_PREFIXES = [
  'user-taught',
  'opus-classified:slang',
  'opus-classified:fandom',
  'opus-rest-classified:slang',
  'opus-rest-classified:fandom',
  '群内黑话',
] as const;

export type LearnedFactTopicPrefix = typeof LEARNED_FACT_TOPIC_PREFIXES[number];

/** Build the 6 exact topic strings for a given term (suffix = term, no mutation). */
export function topicStringsForTerm(
  term: string,
): [string, string, string, string, string, string] {
  return LEARNED_FACT_TOPIC_PREFIXES.map(p => `${p}:${term}`) as
    [string, string, string, string, string, string];
}
```

JSDoc kept to the block shown — do not expand.

---

### 2.2 EDIT `src/storage/db.ts`

#### 2.2.a Interface addition — around line 436

Insert a new line in `ILearnedFactsRepository` immediately after `listActive(...)`:

```typescript
  /**
   * Return all active facts whose topic is one of the 6 canonical prefixes
   * for this term. Result is tiny by construction (≤ 6 rows per term) — no
   * LIMIT clause, no truncation risk. Returns empty array when no match.
   * Exact topic match (no substring leak): `findActiveByTopicTerm(gid,'tt')`
   * never returns `user-taught:xtt`.
   */
  findActiveByTopicTerm(groupId: string, term: string): LearnedFact[];
```

#### 2.2.b Implementation — insert into `LearnedFactsRepository` class

Insert method **above** `listActive` (near line 1953):

```typescript
  findActiveByTopicTerm(groupId: string, term: string): LearnedFact[] {
    const topics = topicStringsForTerm(term);
    const rows = this.db.prepare(
      `SELECT * FROM learned_facts
       WHERE group_id = ? AND status = 'active'
       AND topic IN (?, ?, ?, ?, ?, ?)
       ORDER BY id DESC`
    ).all(groupId, ...topics) as unknown as LearnedFactRow[];
    return rows.map(learnedFactFromRow);
  }
```

Add to imports at top of `db.ts`:

```typescript
import { topicStringsForTerm } from '../modules/fact-topic-prefixes';
```

Use the existing `LearnedFactRow` type and `learnedFactFromRow` helper (both already in scope in this file).

#### 2.2.c `insertOrSupersede` UPDATE clause change — lines 1912–1951

Current code at 1935–1939:

```typescript
      const updateResult = this.db.prepare(
        `UPDATE learned_facts SET status = 'superseded', updated_at = ?
         WHERE group_id = ? AND status = 'active'
         AND (canonical_form LIKE ? OR fact LIKE ?)`,
      ).run(now, groupId, like, like) as { changes: number };
```

Replace with:

```typescript
      const isUserTaught = row.topic?.startsWith('user-taught:') ?? false;
      const updateSql = isUserTaught
        ? `UPDATE learned_facts SET status = 'superseded', updated_at = ?
           WHERE group_id = ? AND status = 'active'
           AND (canonical_form LIKE ? OR fact LIKE ?)`
        : `UPDATE learned_facts SET status = 'superseded', updated_at = ?
           WHERE group_id = ? AND status = 'active'
           AND NOT topic LIKE 'user-taught:%'
           AND (canonical_form LIKE ? OR fact LIKE ?)`;
      const updateResult = this.db.prepare(updateSql)
        .run(now, groupId, like, like) as { changes: number };
```

Do NOT change the 50-row guard (lines 1923–1929). Do NOT change `BEGIN IMMEDIATE` / `COMMIT`. Do NOT change the logger.

---

### 2.3 CREATE `src/modules/fact-candidate-validator.ts`

```typescript
import type { Logger } from 'pino';
import type { LearnedFact } from '../storage/db';

export interface FactCandidateInput {
  /** canonical_form / canonical_fact text of the miner candidate */
  canonical: string;
  /** constructed topic string (e.g. "群内梗 ygfn的意思"); null if no topic */
  topic: string | null;
  /** term being superseded/inserted (used for logging and caller context) */
  term: string;
  /** group scope */
  groupId: string;
  /** active rows for this term — caller fetches via findActiveByTopicTerm */
  existingActiveRows: LearnedFact[];
}

export interface FactCandidateResult {
  accept: boolean;
  rejectReason?: string;
}

const CONFUSION_RE = /询问|问|不知道|含义不明|不清楚|是啥|是谁|啥意思|什么意思|新梗|可能|推测|表明/;
const DEFINITION_RE = /=|即|指|就是|缩写为|全名是|CV=|中文名/;
const SPEAKER_SUBJECT_RE =
  /^(西瓜|风平浪静|[^\s]+)[🍉\s]*(多次|曾经|反复|一直|总|又)?(询问|问过|不知道|搞不清)/;

export function shouldAcceptFactCandidate(
  input: FactCandidateInput,
  logger?: Logger,
): FactCandidateResult {
  const { canonical, topic, term, groupId, existingActiveRows } = input;
  const isUserTaughtCandidate = topic?.startsWith('user-taught:') ?? false;

  // Rule 1 — existing user-taught blocks all non-user-taught candidates.
  if (!isUserTaughtCandidate) {
    const hasUserTaught = existingActiveRows.some(
      r => r.topic?.startsWith('user-taught:') ?? false,
    );
    if (hasUserTaught) {
      const reject = {
        accept: false,
        rejectReason: 'existing user-taught fact for term — non-user-taught candidate blocked',
      };
      logger?.info(
        { groupId, term, canonical: canonical.slice(0, 80), rejectReason: reject.rejectReason },
        'fact-candidate rejected',
      );
      return reject;
    }
  }

  const hasDefinition = DEFINITION_RE.test(canonical);

  // Rule 2 — confusion keyword without definition marker.
  if (CONFUSION_RE.test(canonical) && !hasDefinition) {
    const reject = {
      accept: false,
      rejectReason: 'confusion pattern in canonical without definitive marker',
    };
    logger?.info(
      { groupId, term, canonical: canonical.slice(0, 80), rejectReason: reject.rejectReason },
      'fact-candidate rejected',
    );
    return reject;
  }

  // Rule 3 — 群内梗 topic + speaker-as-subject confusion pattern, no def verb.
  if (topic?.startsWith('群内梗') && SPEAKER_SUBJECT_RE.test(canonical) && !hasDefinition) {
    const reject = {
      accept: false,
      rejectReason: '群内梗 topic with speaker-as-subject confusion pattern',
    };
    logger?.info(
      { groupId, term, canonical: canonical.slice(0, 80), rejectReason: reject.rejectReason },
      'fact-candidate rejected',
    );
    return reject;
  }

  return { accept: true };
}
```

Accept-override note: hasDefinition=true short-circuits Rules 2 and 3 (matches Designer §5). Rule 1 still applies. Do NOT add more rules.

---

### 2.4 EDIT `src/modules/on-demand-lookup.ts`

#### 2.4.a Remove (lines 93–104)

```typescript
        const factRows = this.db.learnedFacts.listActive(groupId, 500);
        // Match only on the TERM extracted from the topic, not on substring of canonical/persona.
        // Topic format: `<prefix>:<...>:<TERM>` — we extract the final segment.
        const TOPIC_TERM_RE = /(?:user-taught|opus-classified:slang|opus-rest-classified:slang|opus-classified:fandom|opus-rest-classified:fandom|群内黑话):([^:]+)$/;
        const normalizedLower = normalizedTerm.toLowerCase();
        const matches = factRows.filter(r => {
          if (!r.topic) return false;
          const m = r.topic.match(TOPIC_TERM_RE);
          if (!m) return false;
          return m[1].toLowerCase().trim() === normalizedLower;
        });
```

#### 2.4.b Replace with

```typescript
        const matches = this.db.learnedFacts.findActiveByTopicTerm(groupId, normalizedTerm);
```

#### 2.4.c Keep unchanged

- `priorityRank` function (lines 106–112)
- `matches.sort(...)` block (lines 113–120)
- Hit-handling (lines 122–127)
- Outer `try/catch` + `logger.warn` on failure

No changes to FTS fallback path, `_inferMeaning`, or anything after line 131.

---

### 2.5 EDIT `src/modules/opportunistic-harvest.ts`

#### 2.5.a Add import near top of file (alongside existing imports)

```typescript
import { shouldAcceptFactCandidate } from './fact-candidate-validator';
```

#### 2.5.b Gate the insert at line ~366

**Before** the `this.learnedFacts.insert({...})` call (line 366), extract the term, fetch per-term active rows via `findActiveByTopicTerm`, and call validator. Term extraction from topic: the topic is built at line 350 as `${category} ${rawTopic}` or `rawTopic` alone. We cannot reliably regex the term back out. Use `item.topic` (the trimmed raw topic from the LLM item) — if it looks like `ygfn的意思`, `ygfn`, `xtt是什么` — that's the best we have. Developer should:

- Add a helper at top of the loop body (before the insert):

```typescript
      // Extract the term from the miner candidate's topic string. Miner topics
      // vary ("ygfn的意思", "xtt", "群内梗 ygfn"): try the final whitespace-token,
      // strip common Chinese suffixes. Falls back to empty string → gate treated
      // as no user-taught match (Rule 1 skipped, Rules 2/3 still apply).
      const candidateTerm = (() => {
        const t = (rawTopic ?? category ?? '').trim();
        if (!t) return '';
        const lastToken = t.split(/\s+/).pop() ?? '';
        return lastToken.replace(/(的意思|是什么|是啥|是谁)$/u, '').trim();
      })();

      const existingForTerm = candidateTerm
        ? this.learnedFacts.findActiveByTopicTerm(groupId, candidateTerm)
        : [];

      const gate = shouldAcceptFactCandidate(
        {
          canonical: canonicalText,
          topic,
          term: candidateTerm,
          groupId,
          existingActiveRows: existingForTerm,
        },
        this.logger,
      );
      if (!gate.accept) {
        dedupped++;
        continue;
      }
```

Place this **after** the jailbreak check (line 323) and **after** the semantic dedup (line 346), **immediately before** the `this.learnedFacts.insert(...)` call at line 366.

Do NOT replace the existing `listActive(groupId, 1000)` call at line 290 — leave the `existing` array alone for now. The designer noted it has the same limit bug; fixing it is out of scope for this PR (it's used for bulk dedup scan, not term lookup). The per-term lookup via `findActiveByTopicTerm` (above) handles the user-taught existence check correctly.

---

### 2.6 EDIT `src/modules/jargon-miner.ts`

#### 2.6.a Add import

```typescript
import { shouldAcceptFactCandidate } from './fact-candidate-validator';
```

#### 2.6.b Gate the insertOrSupersede at line 387

Before the existing `this.learnedFacts.insertOrSupersede({...}, candidate.content)` call:

```typescript
      const existingForTerm = this.learnedFacts.findActiveByTopicTerm(
        groupId, candidate.content,
      );
      const gate = shouldAcceptFactCandidate(
        {
          canonical: factText,
          topic: '群内黑话',
          term: candidate.content,
          groupId,
          existingActiveRows: existingForTerm,
        },
        this.logger,
      );
      if (!gate.accept) {
        this._markPromoted(groupId, candidate.content);
        continue;
      }
```

`_markPromoted` is kept so rejected candidates don't re-queue on every miner run.

Do NOT change the existing `listActive(groupId, 1000)` at line 367 — same reasoning as opportunistic-harvest: bulk dedup scan, not per-term.

---

## 3. Test File Changes

Four test files. Each must run under existing test harness (`npm test`). Use `better-sqlite3` in-memory DB (`:memory:`) for DB tests — matches existing test patterns in this repo.

### 3.1 `test/db-learned-facts.test.ts` (new or extend existing)

Add a describe block `findActiveByTopicTerm`:

- `it('returns all 6 rows when all topic prefixes active for term')` — insert 6 rows with topics from `topicStringsForTerm('ygfn')`, all status='active'. Call `findActiveByTopicTerm('g1', 'ygfn')`. Expect length=6.
- `it('excludes inactive rows')` — insert 6 active + 1 row with topic `opus-classified:slang:ygfn` status='superseded'. Expect length=6 (only actives).
  - (Note: per Designer §7 the test variant is "5 active + 1 inactive → returns 5". Implement as written: seed 5 active, 1 inactive, expect 5.)
- `it('returns only exact topic match — no substring leak')` — insert `user-taught:xtt` and `user-taught:tt`. Call with `'tt'`. Expect length=1 and returned row has `topic === 'user-taught:tt'`.
- `it('returns empty array for absent term')` — no inserts matching. Call with `'absent'`. Expect `[]`.
- `it('scopes by groupId')` — insert `user-taught:ygfn` in `g2`, query in `g1`. Expect `[]`.
- `it('orders by id DESC')` — insert two active rows for same term under different prefixes; assert first returned has higher id.

### 3.2 `test/db-insert-supersede.test.ts` (new or extend existing)

Add a describe block `user-taught protection`:

- `it('non-user-taught insert leaves existing user-taught row active')` — seed `user-taught:ygfn` (id=A) active, `opus-classified:slang:ygfn` (id=B) active. Call `insertOrSupersede({topic:'opus-classified:slang:ygfn', ...}, 'ygfn')`. Assert: A.status === 'active' (reload from DB), B.status === 'superseded', new row with topic `opus-classified:slang:ygfn` exists and is active.
- `it('user-taught insert supersedes all including other user-taught')` — seed `user-taught:ygfn` (id=A) and `opus-classified:slang:ygfn` (id=B), both active. Call `insertOrSupersede({topic:'user-taught:ygfn', ...}, 'ygfn')`. Assert: A.status === 'superseded', B.status === 'superseded', new user-taught row is sole active for term.
- `it('no existing rows: inserts active, supersededCount=0')` — empty DB, call with opus-classified topic. Assert new row active + returned `supersededCount === 0`.
- `it('two user-taught rows: new user-taught supersedes both')` — seed 2 `user-taught:ygfn` rows both active (only possible via direct DB manipulation in test). New user-taught insert supersedes both.

### 3.3 `test/on-demand-lookup.test.ts` (new or extend existing)

Use mock `ILearnedFactsRepository` if one exists; otherwise stub `findActiveByTopicTerm` directly on the repo passed to `OnDemandLookup` ctor.

- `it('lookupTerm: returns fact from findActiveByTopicTerm (no 500-row cutoff)')` — mock `findActiveByTopicTerm('g1', 'xtt')` returns a single fact with topic `'user-taught:xtt'`, personaForm='小团体'. Call `lookupTerm('g1','xtt','u1')`. Expect `{ type: 'found', meaning: '小团体' }`. Assert mock was called with `('g1', 'xtt')` — NOT with `listActive`.
- `it('lookupTerm: priorityRank prefers user-taught over opus-classified when both present')` — mock returns two rows: `user-taught:ygfn` (meaning='A') and `opus-classified:slang:ygfn` (meaning='B'). Expect returned meaning='A'.
- `it('lookupTerm: falls through to FTS when findActiveByTopicTerm returns empty')` — mock returns `[]`. Assert FTS search is invoked (spy on `db.messages.searchFts`).
- `it('lookupTerm: substring terms do not match (tt vs xtt)')` — mock returns `[]` for `'tt'` even if `xtt` exists in DB (the SQL `IN` does the exact match — the test only needs to assert the mock was called with the term as-is; substring behavior is already covered by db-learned-facts test).

### 3.4 `test/opportunistic-harvest.test.ts` (new or extend existing)

Use existing test setup for `OpportunisticHarvest`. Stub the LLM to return a specific `HarvestItem[]` per test. Stub `learnedFacts.findActiveByTopicTerm` per scenario.

- `it('rejects confusion-pattern candidate without definition marker')` — LLM returns `[{canonical_fact:'西瓜多次询问ygfn是谁，表明ygfn是群内不明缩写', topic:'ygfn的意思', category:'群内梗', ...}]`. `findActiveByTopicTerm` returns `[]`. After run: `learnedFacts.insert` NOT called. Logger.info called with `rejectReason` containing `'confusion pattern'`.
- `it('accepts candidate with definitive marker')` — LLM returns `[{canonical_fact:'ygfn=羊宫妃那', topic:'ygfn', category:'群内梗', ...}]`. `findActiveByTopicTerm` returns `[]`. After run: `learnedFacts.insert` called once with canonical='ygfn=羊宫妃那'.
- `it('definitive marker overrides confusion keyword')` — LLM returns `[{canonical_fact:'ygfn=羊宫妃那，西瓜也问过', ...}]`. Expect accept (inserted).
- `it('blocks non-user-taught candidate when user-taught row exists')` — LLM returns `[{canonical_fact:'xtt=小团体，波士顿的', topic:'xtt', category:'群内梗', ...}]`. `findActiveByTopicTerm` returns `[{topic:'user-taught:xtt', ...}]`. After run: `insert` NOT called. Logger.info with `rejectReason` containing `'existing user-taught fact'`.
- `it('rejects 可能 + no definition')` — canonical='ygfn可能是羊宫妃那的缩写'. Reject.

### 3.5 Regression guarantees

- All existing tests in `test/` must pass unchanged. Do NOT delete old TOPIC_TERM_RE tests; update the ones that exercised it to assert via the new path.
- `npx tsc --noEmit` clean.

---

## 4. Manual QA (after bot restart)

Developer runs these in-chat after PR merge + `pm2 restart qqbot` (NOT required before handoff to Reviewer — Reviewer runs them).

1. `@bot xtt是啥` → bot replies with fact 4387's content (the user-taught xtt definition). Must NOT reply with "懒得想" / "不太懂".
2. `@bot ygfn是谁` → bot replies with fact 4573's content. Must NOT deflect.
3. Let opportunistic-harvest miner run for ≥30 min (check pm2 logs for `opportunistic-harvest cycle`). Inspect `learned_facts` for any new rows whose `canonical_form` matches `/西瓜.*(询问|问过).*(是谁|是啥)/` — expect **zero** new such rows. Rejections should appear in logs as `'fact-candidate rejected'`.
4. Confirm `SELECT id, status, topic FROM learned_facts WHERE id IN (4387, 4573)` returns both rows with `status='active'` and `topic` starting with `user-taught:`.

Reviewer also runs step 4 **before** signing off APPROVED (per Planner §F).

---

## 5. Migration / Schema Impact

**None.** No ALTER TABLE. No new columns. No index changes. The new SQL in `findActiveByTopicTerm` uses only existing columns (`group_id`, `status`, `topic`, all others via `SELECT *`). Existing `idx_learned_facts_group_status_topic` (if present) will cover the lookup; even without it, bounded result set means no perf concern.

Confirmed: no migration script needed.

---

## 6. Risk Highlights for Developer

| Risk | Severity | Mitigation |
|---|---|---|
| `term` passed to `findActiveByTopicTerm` differs in case/whitespace from stored topic suffix | Medium | Caller (`on-demand-lookup.ts`) already calls `term.trim()` at line 91 to produce `normalizedTerm`. Topics are stored suffix-exact by `insertOrSupersede` callers. No lowercase canonicalization — if users taught `xTt` and look up `xtt`, they miss. Accepted behavior; document in fact-topic-prefixes.ts if concern escalates. |
| Miner candidate term extraction heuristic (§2.5.b) returns wrong token for exotic topic strings | Medium | Falls back to `''` which skips Rule 1 (user-taught guard) but keeps Rules 2 + 3 (confusion pattern guards still fire). Worst case: non-user-taught candidate for already-taught term slips through — but `insertOrSupersede` protection (§2.2.c) still prevents it from killing the user-taught row. Defense in depth. |
| Confusion regex over-fires on valid facts containing `问` (e.g. "ygfn是羊宫妃那，大家都问过") | Medium | Accept rule: if `DEFINITION_RE` matches, we accept regardless of confusion keywords. Test `3.4 — definitive marker overrides` covers this. Post-deploy: monitor 30-min `'fact-candidate rejected'` logs for false positives. |
| `existing` array in opportunistic-harvest (line 290) still has 1000-row limit bug | Low | Out of scope for this PR — per Designer §6. Array is used for bulk dedup (`includes(prefix)`), not per-term lookup. Per-term user-taught check uses `findActiveByTopicTerm` (unlimited). File follow-up task. |
| Two `user-taught:TERM` rows both active at once | Low | Possible if old data predates this PR. `findActiveByTopicTerm` returns both; `priorityRank` ties both at 0, sort by persona/fact length breaks tie. Acceptable. `insertOrSupersede` for new user-taught will supersede both going forward. |
| Miner logger spam from rejections | Low | Info level per Designer §5. If volume is high post-deploy, Reviewer/admin can downgrade to debug in a follow-up — do NOT downgrade preemptively. |
| `jargon-miner.ts` `candidate.content` is term-shaped but may have whitespace/punctuation | Low | Reuse existing string as-is (`candidate.content`). Jargon miner already normalizes during candidate construction. If tests fail on this, trim in validator call, not in jargon-miner. |

---

## 7. Designer Flag Acknowledged

The Designer noted: `opportunistic-harvest.ts:290` uses `listActive(groupId, 1000)` for its `existing` bulk-dedup array, which has the same limit bug as the old Path A shortcut. **Per this spec, Developer does NOT replace that call.** The per-term user-taught existence check (`findActiveByTopicTerm` at §2.5.b) handles the load-bearing check correctly; the 1000-row array remains solely for bulk prefix-dedup, which is best-effort by design. A separate follow-up task should fix it; out of scope for #30.

---

## 8. Handoff Checklist

Developer signals DONE by:

- [ ] All 6 file edits applied per §2
- [ ] All 4 test files updated/created per §3
- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` all green
- [ ] Committed to branch (single commit or logical sub-commits; no WIP)
- [ ] No changes outside the 8 files named in this spec

Reviewer signals APPROVED by:

- [ ] Read diff, verify no unexpected files touched
- [ ] Re-run `npm test` + `npx tsc --noEmit` locally
- [ ] Run Manual QA §4 on live bot (requires pm2 restart)
- [ ] Verify `SELECT id,status FROM learned_facts WHERE id=4573` returns `active`
- [ ] Save code review to `.claude/code-reviews.md`

---

**End of DEV-READY spec.** No code in this document is pre-written for Developer — it is structural guidance only. Developer makes final line-level choices within these bounds.
