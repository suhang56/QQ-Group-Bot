# R6.1 Sampling + Weak Labeling — DEV-READY

**Architect sign-off date**: 2026-04-19  
**Scope**: `scripts/eval/*` + `docs/eval/*` + `.gitignore` additions + synthetic test fixture only.  
**Hard constraint**: zero runtime code changes, zero production DB writes, zero LLM calls.

---

## 0. Planner Open Questions — Resolved

| # | Question | Resolution |
|---|---|---|
| 1 | DB client | **`DatabaseSync` from `node:sqlite`** (Node 22 built-in). Already used throughout `src/storage/db.ts`. Do NOT introduce `better-sqlite3`. |
| 2 | `learned_facts` query shape | Structural key equality: `topic = tok OR canonical_form = tok` per token from `extractTokens`. NOT LIKE substring — see §6 for full helper. |
| 3 | Seed strategy | `crypto.createHash('sha256').update(\`${seed}:${rowId}\`).digest('hex')` → BigInt slice → mod. Seeded Fisher-Yates on top of `ORDER BY id DESC LIMIT N`. Full impl in §3. |
| 4 | Vitest config for integration tests | `vitest.config.ts` **excludes** `*.integration.test.ts`. Eval tests MUST be named `sample-benchmark.test.ts` (plain `.test.ts`) to be picked up. The config includes `test/**/*.test.ts`. |
| 5 | gitkeep convention | Project does NOT use `.gitkeep`. `test/fixtures/` already exists. No placeholder files needed — just add `eval-sample.sqlite` directly. |

---

## 1. Module Layout

```
scripts/eval/
  types.ts                    -- shared interfaces (SampledRow, WeakReplayLabel, SummaryJson)
  sample-benchmark.ts         -- entry point: args --seed --per-category-target --output-dir
  weak-label.ts               -- apply WeakReplayLabel to a SampledRow
  summary.ts                  -- aggregate rows → summary.json
  categories/
    index.ts                  -- re-exports all category predicates
    cat1-direct-at-bot.ts
    cat2-known-fact-term.ts
    cat3-rhetorical-banter.ts
    cat4-image-mface.ts
    cat5-bot-status-context.ts
    cat6-burst-nondirect.ts
    cat7-relay.ts
    cat8-conflict-heat.ts
    cat9-normal-chimein.ts
    cat10-silence-candidate.ts

docs/eval/
  schema.md                   -- human-readable schema reference (JSONL + summary.json)

test/
  fixtures/
    eval-sample.sqlite        -- synthetic 100-row DB (committed, small)
  eval/
    sample-benchmark.test.ts  -- integration test
```

---

## 2. Types (`scripts/eval/types.ts`)

```ts
export type ExpectedAct =
  | 'direct_chat'
  | 'chime_in'
  | 'conflict_handle'
  | 'summarize'
  | 'bot_status_query'
  | 'relay'
  | 'meta_admin_status'
  | 'object_react';

export type ExpectedDecision = 'reply' | 'silent' | 'defer';

export interface WeakReplayLabel {
  expectedAct: ExpectedAct;
  expectedDecision: ExpectedDecision;
  hasKnownFactTerm: boolean;
  hasRealFactHit: boolean;      // R6.1: set equal to hasKnownFactTerm; true retrieval deferred to R6.3
  allowPluralYou: boolean;
  isObjectReact: boolean;
  isBotStatusContext: boolean;
  isBurst: boolean;
  isRelay: boolean;
  isDirect: boolean;
  riskFlags: string[];
}

export interface ContextMessage {
  id: number;
  userId: string;
  nickname: string;
  content: string;
  timestamp: number;
}

export interface SampledRow {
  // identity
  id: string;                      // `${groupId}:${messageId}` — stable across reruns
  groupId: string;
  messageId: number;               // messages.id
  sourceMessageId: string | null;  // messages.source_message_id
  userId: string;
  nickname: string;
  timestamp: number;               // epoch seconds
  // content
  content: string;
  rawContent: string | null;
  // context window: 5 before (ASC order), 3 after (ASC order)
  triggerContext: ContextMessage[];       // 5 messages preceding (ASC)
  triggerContextAfter: ContextMessage[];  // 3 messages following (ASC)
  // sampling metadata
  category: number;         // 1–10
  categoryLabel: string;    // human-readable name
  samplingSeed: number;     // the --seed value used
  contentHash: string;      // sha256(content).slice(0,16) — duplicate detection
}

export interface WeakLabeledRow extends SampledRow {
  label: WeakReplayLabel;
}

export interface CategorySummary {
  category: number;
  label: string;
  sampled: number;
  target: number;
  gap: number;
}

export interface SummaryJson {
  generatedAt: number;          // epoch seconds
  seed: number;
  perCategoryTarget: number;
  totalSampled: number;
  categories: CategorySummary[];
  duplicateCount: number;       // rows sharing contentHash with another row
  duplicateRate: number;        // duplicateCount / totalSampled
  emptyContentCount: number;
  malformedCount: number;
}
```

---

## 3. Deterministic Seed Implementation

All category SQL queries use **`ORDER BY id DESC LIMIT N`** for recency-lean with a deterministic stable order.

Post-SQL per-category shuffle uses a seeded PRNG so re-runs produce identical output for the same DB state + seed:

```ts
import { createHash } from 'crypto';

// Returns a float in [0, 1) deterministically from seed + row id.
export function seededRand(seed: number, rowId: number): number {
  const hex = createHash('sha256')
    .update(`${seed}:${rowId}`)
    .digest('hex');
  // Take first 13 hex chars → 52-bit integer → divide by 2^52
  return Number(BigInt('0x' + hex.slice(0, 13))) / Number(2n ** 52n);
}

// Seeded Fisher-Yates shuffle of rows, then take first perCategoryTarget.
export function seededSample<T extends { messageId: number }>(
  rows: T[],
  seed: number,
  target: number,
): T[] {
  const arr = [...rows];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(seededRand(seed, arr[i].messageId) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, target);
}
```

**Why ORDER BY id DESC + seeded shuffle**: SQL `ORDER BY RANDOM()` is non-reproducible and ignores seed. `ORDER BY id DESC LIMIT N` fetches recent candidates deterministically, then `seededSample` picks the final target count with seed-controlled randomness. Same DB + same seed always yields identical output.

---

## 4. SQL Queries Per Category

All queries run read-only against the production messages table. `?` placeholders: `[groupId, limit]` unless noted. `limit` = `perCategoryTarget * 5` (pre-filter headroom; seededSample reduces to target).

### Cat 1 — Direct @ / reply-to-bot
```sql
SELECT m.*
FROM messages m
WHERE m.group_id = ?
  AND m.deleted = 0
  AND (
    m.content LIKE '%[CQ:at,qq=' || ? || '%'   -- ? = botQQ
    OR m.raw_content LIKE '%[CQ:at,qq=' || ? || '%'
  )
ORDER BY m.id DESC
LIMIT ?
```
Placeholders: `[groupId, botQQ, botQQ, limit]`

### Cat 2 — Known fact term
```sql
SELECT DISTINCT m.*
FROM messages m
JOIN learned_facts lf
  ON lf.group_id = m.group_id
  AND lf.status = 'active'
  AND (
    m.content LIKE '%' || lf.topic || '%'
    OR (lf.canonical_form IS NOT NULL AND m.content LIKE '%' || lf.canonical_form || '%')
  )
WHERE m.group_id = ?
  AND m.deleted = 0
ORDER BY m.id DESC
LIMIT ?
```
Note: LIKE join on topic/canonical_form is a structural key match, not substring of long sentences. See §6 for the `hasKnownFactTerm` helper which replicates this at label time.

### Cat 3 — Rhetorical banter / 啥情况 类吐槽
```sql
SELECT m.*
FROM messages m
WHERE m.group_id = ?
  AND m.deleted = 0
  AND (
    m.content LIKE '%啥情况%'
    OR m.content LIKE '%怎么回事%'
    OR m.content LIKE '%搞什么%'
    OR m.content LIKE '%这是%啊%'
    OR m.content LIKE '%什么鬼%'
    OR m.content LIKE '%wtf%'
    OR m.content LIKE '%服了%'
    OR m.content LIKE '%无语%'
    OR m.content LIKE '%离谱%'
    OR m.content LIKE '%哈哈%'
    OR m.content LIKE '%哈哈哈%'
    OR m.content LIKE '%笑死%'
  )
  AND m.content NOT LIKE '%[CQ:image%'
ORDER BY m.id DESC
LIMIT ?
```

### Cat 4 — Image / mface / image + short caption
```sql
SELECT m.*
FROM messages m
WHERE m.group_id = ?
  AND m.deleted = 0
  AND (
    m.raw_content LIKE '%[CQ:image%'
    OR m.raw_content LIKE '%[CQ:mface%'
    OR m.raw_content LIKE '%[CQ:face%'
  )
ORDER BY m.id DESC
LIMIT ?
```
Post-filter in predicate: split raw_content on CQ codes, remaining text length 0–12 qualifies as "image + short caption".

### Cat 5 — Bot status context (禁言 / 策略 / 机器人 keywords)
```sql
SELECT m.*
FROM messages m
WHERE m.group_id = ?
  AND m.deleted = 0
  AND (
    m.content LIKE '%禁言%'
    OR m.content LIKE '%解禁%'
    OR m.content LIKE '%策略%'
    OR m.content LIKE '%小号%'
    OR m.content LIKE '%机器人%'
    OR m.content LIKE '%bot%'
    OR m.content LIKE '%屏蔽%'
    OR m.content LIKE '%沉默%'
    OR m.content LIKE '%为什么不说话%'
    OR m.content LIKE '%你死了%'
    OR m.content LIKE '%你怎么不回%'
  )
ORDER BY m.id DESC
LIMIT ?
```

### Cat 6 — Burst non-direct (≥5 msgs in 15s window)
```sql
SELECT m.*
FROM messages m
WHERE m.group_id = ?
  AND m.deleted = 0
  AND m.id IN (
    SELECT m2.id
    FROM messages m2
    WHERE m2.group_id = ?
      AND m2.deleted = 0
      AND (
        SELECT COUNT(*) FROM messages m3
        WHERE m3.group_id = m2.group_id
          AND m3.deleted = 0
          AND m3.timestamp BETWEEN m2.timestamp - 15 AND m2.timestamp + 15
          AND m3.id != m2.id
      ) >= 4
  )
ORDER BY m.id DESC
LIMIT ?
```
Placeholders: `[groupId, groupId, limit]`

### Cat 7 — Relay / repeater (接龙 / 扣1 / duplicate within 30s)
```sql
SELECT m.*
FROM messages m
WHERE m.group_id = ?
  AND m.deleted = 0
  AND (
    m.content IN ('1', '2', '3', '扣1', '接龙', '+1', '！', '!', '冲')
    OR (
      SELECT COUNT(*) FROM messages m2
      WHERE m2.group_id = m.group_id
        AND m2.deleted = 0
        AND m2.content = m.content
        AND ABS(m2.timestamp - m.timestamp) <= 30
        AND m2.id != m.id
        AND LENGTH(m.content) >= 2
    ) >= 2
  )
ORDER BY m.id DESC
LIMIT ?
```

### Cat 8 — Conflict / heat (insult / curse / probe patterns)
```sql
SELECT m.*
FROM messages m
WHERE m.group_id = ?
  AND m.deleted = 0
  AND (
    m.content LIKE '%你他妈%'
    OR m.content LIKE '%草你%'
    OR m.content LIKE '%傻逼%'
    OR m.content LIKE '%废物%'
    OR m.content LIKE '%滚%'
    OR m.content LIKE '%你妈%'
    OR m.content LIKE '%cnm%'
    OR m.content LIKE '%nmsl%'
    OR m.content LIKE '%sb%'
    OR m.content LIKE '%蠢%'
    OR m.content LIKE '%脑子有病%'
    OR m.content LIKE '%找打%'
  )
ORDER BY m.id DESC
LIMIT ?
```

### Cat 9 — Normal chime-in candidate (multi-speaker, non-direct)
```sql
SELECT m.*
FROM messages m
WHERE m.group_id = ?
  AND m.deleted = 0
  AND m.raw_content NOT LIKE '%[CQ:at%'
  AND m.content NOT LIKE '%[CQ:image%'
  AND LENGTH(m.content) >= 5
  AND m.id IN (
    SELECT m2.id
    FROM messages m2
    WHERE m2.group_id = ?
      AND m2.deleted = 0
      AND (
        SELECT COUNT(DISTINCT m3.user_id) FROM messages m3
        WHERE m3.group_id = m2.group_id
          AND m3.deleted = 0
          AND m3.timestamp BETWEEN m2.timestamp - 120 AND m2.timestamp + 30
      ) >= 3
  )
ORDER BY m.id DESC
LIMIT ?
```
Placeholders: `[groupId, groupId, limit]`

### Cat 10 — Silence candidate (stale, no entities, no direct)
```sql
SELECT m.*
FROM messages m
WHERE m.group_id = ?
  AND m.deleted = 0
  AND m.raw_content NOT LIKE '%[CQ:at%'
  AND (
    LENGTH(m.content) <= 4
    OR m.content IN ('好', '嗯', '哦', 'ok', 'OK', '收到', '了解', '哦哦', '好的', '嗯嗯', 'hm', 'hmm', '啊', '哈')
    OR (
      SELECT COUNT(*) FROM messages m2
      WHERE m2.group_id = m.group_id
        AND m2.deleted = 0
        AND m2.timestamp > m.timestamp
        AND m2.timestamp <= m.timestamp + 300
    ) = 0
  )
ORDER BY m.id DESC
LIMIT ?
```

---

## 5. `hasKnownFactTerm` Implementation (weak-label.ts)

```ts
// Called once per row during weak labeling. db is a read-only DatabaseSync instance (node:sqlite).
export function checkKnownFactTerm(
  db: DatabaseSync,  // node:sqlite DatabaseSync
  groupId: string,
  content: string,
): boolean {
  const tokens = extractTokens(content); // imported from src/modules/honest-gaps.ts
  if (tokens.length === 0) return false;

  // Match by structural KEY: topic equality with a token, not substring of long fields.
  // This prevents meme/sentence facts that MENTION the term from false-matching.
  for (const tok of tokens) {
    const hit = db.prepare(`
      SELECT 1 FROM learned_facts
      WHERE group_id = ?
        AND status = 'active'
        AND (topic = ? OR canonical_form = ?)
      LIMIT 1
    `).get(groupId, tok, tok);
    if (hit) return true;
  }
  return false;
}
```

`hasRealFactHit` is set to the same boolean value in R6.1. Documented caveat in types.ts and schema.md: full retrieval (semantic + BM25 ranking) is R6.3 replay concern.

---

## 6. Weak-Label Rule Precedence (`weak-label.ts`)

First-match-wins, mirroring R4-lite strategy classifier order. Each predicate receives `(row: SampledRow, db: BetterSqlite3.Database)`.

```
1.  isAdminCommand(row)
    → skip row from benchmark output entirely (not labeled)
    Detection: content starts with '/' AND userId in admin list OR is DM (groupId == userId)

2.  isRelayPattern(row)
    → expectedAct='relay', expectedDecision='reply', isRelay=true

3.  isConflictHeat(row)
    → expectedAct='conflict_handle', expectedDecision='reply'

4.  isSummarizeRequest(row) AND triggerContext.length >= 20 (full window check)
    → expectedAct='summarize', expectedDecision='reply'
    Detection: content LIKE '%总结%' OR '%回顾%' OR '%说说刚才%'

5a. isBotStatusKeywords(row) AND isDirect(row)
    → expectedAct='bot_status_query', expectedDecision='reply', isBotStatusContext=true

5b. isBotStatusKeywords(row) AND NOT isDirect(row)
    → expectedAct='meta_admin_status', expectedDecision='defer', isBotStatusContext=true

6.  isPureImageOrMface(row) (no text) OR isImageWithShortCaption(row)
    WHERE shortCaption = stripped-CQ text length 1–12 AND NOT isQuestion AND NOT hasKnownFactTerm
    → expectedAct='object_react', expectedDecision='reply', isObjectReact=true

7.  isDirect(row) AND NOT matched above
    → expectedAct='direct_chat', expectedDecision='reply', isDirect=true

8.  isReplyWorthy(row) (multi-speaker context OR entity present OR interesting length)
    → expectedAct='chime_in', expectedDecision='reply'

9.  default (silence candidate)
    → expectedAct='chime_in', expectedDecision='silent'
```

Helper predicates (all pure functions on row fields):

- `isDirect(row)`: `rawContent` contains `[CQ:at,qq=<botQQ>` OR `sourceMessageId` matches a known bot message id
- `isRelayPattern(row)`: `content` in relay set OR duplicate-within-30s detected via triggerContext
- `isConflictHeat(row)`: matches cat8 keyword list
- `isBotStatusKeywords(row)`: matches cat5 keyword list
- `isQuestion(row)`: content ends with `？` or `?` or starts with `为什么\|怎么\|啥\|几`
- `isPureImageOrMface(row)`: rawContent matches only CQ image/mface/face with no surrounding text
- `isImageWithShortCaption(row)`: rawContent has CQ image/mface + stripped text length 1–12

`riskFlags` populated based on:
- `'legacy-few-shot-possible'` — row timestamp predates R4 deploy date (configurable constant)
- `'ambiguous-target'` — multiple @ targets detected
- `'multi-category-match'` — row would have matched 2+ category predicates
- `'short-context'` — triggerContext.length < 3

---

## 7. Entry Point CLI (`sample-benchmark.ts`)

```
npx tsx scripts/eval/sample-benchmark.ts \
  --db-path    /path/to/bot.db \
  --group-id   <groupId> \
  --bot-qq     <botQQ> \
  --seed       42 \
  --per-category-target 250 \
  --output-dir data/eval
```

Outputs:
- `data/eval/benchmark-raw.jsonl` — one `SampledRow` per line (gitignored)
- `data/eval/benchmark-weak-labeled.jsonl` — one `WeakLabeledRow` per line (gitignored)
- `data/eval/summary.json` — `SummaryJson` (gitignored)

Exit codes: 0 = success, 1 = DB not found, 2 = no rows sampled, 3 = write error.

---

## 8. `.gitignore` Additions

Add to repo root `.gitignore`:

```gitignore
# R6.1 evaluation data (local-only, 58w群聊 not committed)
data/eval/*.jsonl
data/eval/*.json
```

Note: `data/eval/` directory itself is NOT ignored — a future `data/eval/fixtures/` subdir may be committed for synthetic test data.

---

## 9. Test Contract

**File**: `test/eval/sample-benchmark.test.ts`  
**Naming**: must end in `.test.ts` (NOT `.integration.test.ts` — vitest.config.ts excludes that suffix).  
**Fixture**: `test/fixtures/eval-sample.sqlite` (synthetic, committed, small — `test/fixtures/` already exists, no gitkeep needed)

### Fixture requirements (100 rows, one group `test-group-001`)

The fixture must have at least 2 representative rows per category so each category can hit its target (10 per-category target in tests). Concretely:

| Category | Minimum fixture rows | Key field values |
|---|---|---|
| 1 direct | 3 | rawContent contains `[CQ:at,qq=12345` |
| 2 known-fact | 3 | content contains a topic that exists in learned_facts table |
| 3 banter | 3 | content LIKE '%啥情况%' |
| 4 image | 3 | rawContent contains `[CQ:image` |
| 5 bot-status | 3 | content LIKE '%机器人%' |
| 6 burst | 5 | 5 rows with timestamps within 15s |
| 7 relay | 3 | content = '1' or duplicate within 30s |
| 8 conflict | 3 | content LIKE '%sb%' |
| 9 chime-in | 3 | 3 distinct user_ids within 120s window |
| 10 silence | 3 | short content or no following messages |

Fixture also includes 3 rows in `learned_facts` for cat2 overlap testing.

### Assertions

```ts
describe('sample-benchmark integration', () => {
  it('produces correct per-category counts', () => {
    // run with --seed 1 --per-category-target 3
    // each category with 3+ fixture rows → count == 3
  });

  it('is deterministic: same seed → same output hash', () => {
    // run twice with seed=42, hash JSONL output, assert equal
  });

  it('summary.json is populated', () => {
    // assert totalSampled > 0, categories.length == 10
    // assert duplicateRate in [0, 1]
  });

  it('WeakReplayLabel fields are correctly populated for cat1', () => {
    // direct @ row → isDirect=true, expectedAct='direct_chat'
  });

  it('WeakReplayLabel fields for cat7 relay', () => {
    // relay row → isRelay=true, expectedAct='relay'
  });

  it('hasRealFactHit equals hasKnownFactTerm in R6.1', () => {
    // for all rows, label.hasRealFactHit === label.hasKnownFactTerm
  });

  it('admin command rows are excluded from output', () => {
    // fixture row starting with '/' from admin user → absent from output JSONL
  });
});
```

---

## 10. Architecture Health Assessment

### Clean
- All new code is `scripts/eval/*` — zero runtime surface, zero production risk.
- No circular deps: `sample-benchmark` imports `categories/*` and `weak-label`; `weak-label` imports `types` and `src/modules/honest-gaps` (read-only extractTokens). No inverse dependencies.
- `extractTokens` import from `src/modules/honest-gaps.ts` is acceptable: it's a pure function with no DB/framework deps. If this causes path issues in eval context, inline a copy — do not introduce a new shared util just for this.

### Risks flagged (non-blocking for R6.1)
1. **Cat 6 burst subquery** (correlated COUNT) will be slow on large DBs. For a one-time sampling script this is acceptable. If runtime >30s, replace with a pre-computed CTE or window function.
2. **Cat 2 LIKE join on `topic`** may match multi-word topic strings partially. `extractTokens` length bounds (MIN_TERM_LEN, MAX_TERM_LEN) constrain this. The checkKnownFactTerm helper uses equality (`= tok`) not LIKE, so label-time is precise; SQL sample query uses LIKE for breadth intentionally.
3. **`hasRealFactHit = hasKnownFactTerm` documented caveat**: must appear in `docs/eval/schema.md` and inline comment in `types.ts` so R6.3 dev knows to replace this at replay time.

### Missing test coverage — BLOCKER
The test contract above is mandatory before merge. The following edge cases MUST be covered:
- Empty fixture DB → graceful exit code 2, no output files written
- Category with 0 qualifying rows → appears in summary.json with `sampled: 0, gap: target`
- Row matching 2+ category predicates → appears only in first-matched category, `riskFlags` contains `'multi-category-match'`
- seed=0 is valid (not treated as falsy) — test explicitly with seed=0

---

## 11. docs/eval/schema.md Outline

The file must document:
1. `benchmark-raw.jsonl` — one `SampledRow` per line, UTF-8, fields defined in §2 above
2. `benchmark-weak-labeled.jsonl` — `WeakLabeledRow` = `SampledRow` + `label: WeakReplayLabel`
3. `summary.json` — `SummaryJson` shape with field descriptions
4. `contentHash` derivation: `sha256(content).slice(0, 16)` hex
5. `triggerContext` window: 5 messages before (ASC), 3 after (ASC) — window size chosen to cover a typical 2-minute burst without ballooning file size
6. `hasRealFactHit` caveat: "In R6.1, equals `hasKnownFactTerm`. Will be replaced in R6.3 with output of full retrieval pipeline on replayed row."
7. Gitignore note: `data/eval/*.jsonl` and `data/eval/*.json` are local-only assets

---

*Unresolved for Developer*: `botQQ` value must be passed as CLI arg or read from bot config — do not hardcode. Suggest reading from `config.ts` exported constant if importable without side effects, otherwise `--bot-qq` CLI arg is the fallback.
