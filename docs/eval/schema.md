# R6.1 Eval Sampling — Schema Reference

## Output Files

| File | Description |
|------|-------------|
| `data/eval/benchmark-raw.jsonl` | One `SampledRow` per line, UTF-8 |
| `data/eval/benchmark-weak-labeled.jsonl` | `WeakLabeledRow` = `SampledRow` + `label: WeakReplayLabel` |
| `data/eval/summary.json` | `SummaryJson` aggregate statistics |

**These files are gitignored** via `data/eval/*.jsonl` and `data/eval/*.json` — local-only assets (58w群聊 not committed). The `data/eval/` directory itself is tracked so future subdirs (`data/eval/fixtures/`) can be committed.

---

## `benchmark-raw.jsonl` — `SampledRow`

```ts
{
  id: string;                       // `${groupId}:${messageId}` — stable across reruns
  groupId: string;
  messageId: number;                // messages.id (integer primary key)
  sourceMessageId: string | null;   // messages.source_message_id
  userId: string;
  nickname: string;
  timestamp: number;                // epoch seconds (same unit as messages.timestamp)
  content: string;
  rawContent: string | null;
  triggerContext: ContextMessage[];      // 5 messages preceding (ASC order)
  triggerContextAfter: ContextMessage[]; // 3 messages following (ASC order)
  category: number;                 // 1–10 (see §Categories)
  categoryLabel: string;            // human-readable name
  samplingSeed: number;             // the --seed integer used
  contentHash: string;              // sha256(content).slice(0,16) hex — duplicate detection
}
```

### `ContextMessage`

```ts
{
  id: number;
  userId: string;
  nickname: string;
  content: string;
  timestamp: number;   // epoch seconds
}
```

### `contentHash` derivation

```ts
sha256(content).digest('hex').slice(0, 16)
```

### Context window

- **5 before** (triggerContext): sufficient to detect burst (15s window), relay chains (30s lookback), multi-speaker presence
- **3 after** (triggerContextAfter): minimum for silence validation and aftermath context in R6.3 replay
- Asymmetry intentional: causation flows from past; aftermath is a sanity signal only

---

## `benchmark-weak-labeled.jsonl` — `WeakLabeledRow`

All fields from `SampledRow`, plus:

```ts
{
  label: {
    expectedAct: ExpectedAct;
    expectedDecision: 'reply' | 'silent' | 'defer';
    hasKnownFactTerm: boolean;
    hasRealFactHit: boolean;   // R6.1: equals hasKnownFactTerm (see caveat below)
    allowPluralYou: boolean;
    isObjectReact: boolean;
    isBotStatusContext: boolean;
    isBurst: boolean;
    isRelay: boolean;
    isDirect: boolean;
    riskFlags: string[];       // 'legacy-few-shot-possible' | 'ambiguous-target' | 'multi-category-match' | 'short-context'
  }
}
```

### `hasRealFactHit` caveat

In R6.1, `hasRealFactHit` equals `hasKnownFactTerm`. True fact hit detection requires running the full retrieval pipeline (semantic search + BM25 ranking) on the replayed row — this is deferred to R6.3. At R6.3, replace this field with the actual output of `checkKnownFactTerm` on each replayed row.

### `ExpectedAct` values

| Value | Trigger |
|-------|---------|
| `relay` | Relay chain detected (扣1, +1, echo, vote) |
| `conflict_handle` | Conflict/insult keywords in content |
| `summarize` | Summarize request + long context (≥20 msgs) |
| `bot_status_query` | Bot-referent (@bot) + status keywords |
| `meta_admin_status` | Status keywords, no @bot |
| `object_react` | Pure image/mface or image+short caption (1–12 chars), no known-fact term |
| `direct_chat` | @bot or reply-to-bot (after above guards) |
| `chime_in` | Multi-speaker or interesting-length content |

### Weak-label precedence (first match wins)

1. Admin command (`/...`) → **skip row** (not in labeled output)
2. Relay pattern → `expectedAct='relay'`
3. Conflict heat → `expectedAct='conflict_handle'`
4. Summarize + context ≥ 20 → `expectedAct='summarize'`
5a. Bot-status + isDirect → `expectedAct='bot_status_query'`
5b. Bot-status + not-direct → `expectedAct='meta_admin_status', expectedDecision='defer'`
6. Pure image or short-caption image (no known-fact) → `expectedAct='object_react'`
7. isDirect (not matched above) → `expectedAct='direct_chat'`
8. Multi-speaker or long content → `expectedAct='chime_in', expectedDecision='reply'`
9. Default → `expectedAct='chime_in', expectedDecision='silent'`

---

## `summary.json` — `SummaryJson`

```ts
{
  generatedAt: number;          // epoch seconds
  seed: number;                 // --seed value used
  perCategoryTarget: number;    // --per-category-target value
  totalSampled: number;
  categories: Array<{
    category: number;           // 1–10
    label: string;              // human-readable name
    sampled: number;
    target: number;
    gap: number;                // target - sampled (0 if at target)
  }>;
  duplicateCount: number;       // rows sharing contentHash with another row
  duplicateRate: number;        // duplicateCount / totalSampled (0.0–1.0)
  emptyContentCount: number;
  malformedCount: number;
}
```

---

## Categories (1–10)

| # | Label | Detection |
|---|-------|-----------|
| 1 | `direct_at_bot` | rawContent contains `[CQ:at,qq=<botQQ>` |
| 2 | `known_fact_term` | content LIKE-matches a learned_facts topic or canonical_form |
| 3 | `rhetorical_banter` | 啥情况/无语/离谱/哈哈/笑死/wtf/etc. keywords, no image |
| 4 | `image_mface` | rawContent contains `[CQ:image`, `[CQ:mface`, or `[CQ:face` |
| 5 | `bot_status_context` | 禁言/策略/机器人/bot/沉默/etc. keywords |
| 6 | `burst_nondirect` | ≥4 other messages within ±15s of this message |
| 7 | `relay` | content in relay set OR duplicate within 30s in context |
| 8 | `conflict_heat` | 傻逼/废物/滚/sb/cnm/etc. keywords |
| 9 | `normal_chimein` | ≥3 distinct speakers in 120s window, content ≥5 chars, no @ or image |
| 10 | `silence_candidate` | content ≤4 chars, or in ack-set, or no following msgs within 300s |

**Category assignment priority**: categories are queried 1→10; a row appearing in an earlier category is excluded from later ones (cross-category deduplication via `seen` set).

---

## Running the Sampler

```bash
npx tsx scripts/eval/sample-benchmark.ts \
  --db-path /path/to/bot.db \
  --group-id <groupId> \
  --bot-qq <botQQ> \
  --seed 42 \
  --per-category-target 250 \
  --output-dir data/eval
```

Exit codes: `0` success, `1` DB not found, `2` no rows sampled, `3` write error.

Outputs land in `data/eval/` and are gitignored. Do NOT commit them.
