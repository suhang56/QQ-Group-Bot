# R6.1 Eval Sampling — Schema Reference

## Overview

The eval sampling pipeline produces three output files:

| File | Description |
|------|-------------|
| `benchmark-raw.jsonl` | One JSON object per line, sampled trigger messages with context |
| `benchmark-weak-labeled.jsonl` | Same rows + `label` field with rule-based weak labels |
| `summary.json` | Aggregate statistics for the sampling run |

**These files are NOT committed to the repo** (gitignored via `data/eval/*.jsonl`, `data/eval/*.json`).
Only fixture SQLite files under `test/fixtures/` are committed.

---

## `benchmark-raw.jsonl` — Row Schema

Each line is a JSON object:

```ts
{
  id: string;                   // UUID v4, stable: sha256(seed:groupId:messageId) → uuid-format
  groupId: string;              // QQ group ID (string to avoid JS precision loss on large IDs)
  messageId: string;            // messages.id from source DB
  userId: string;               // sender QQ ID
  nickname: string;             // sender display name at sample time
  timestamp: number;            // Unix epoch seconds (integer) — same unit as messages.timestamp
  content: string;              // processed content (CQ codes present but stripped for display)
  rawContent: string;           // raw message content exactly as stored
  triggerContext: ContextMsg[]; // 5 preceding messages (oldest first)
  triggerContextAfter: ContextMsg[]; // 3 following messages (oldest first)
  category: SamplingCategory;   // one of 10 enum values (see §Categories)
  samplingSeed: string;         // hex seed used — re-run with same seed for identical output
}
```

### `ContextMsg`

```ts
{
  messageId: string;
  userId: string;
  nickname: string;
  timestamp: number;   // Unix epoch seconds
  content: string;
  rawContent: string;
}
```

---

## `benchmark-weak-labeled.jsonl` — Row Schema

All fields from `benchmark-raw.jsonl`, plus:

```ts
{
  label: {
    expectedAct: ExpectedAct;       // primary action label (see §ExpectedAct)
    expectedDecision: ExpectedDecision; // 'reply' | 'silent' | 'defer'
    hasKnownFactTerm: boolean;      // any token hits learned_facts canonical/fact
    hasRealFactHit: boolean;        // R6.1: equals hasKnownFactTerm (runtime retrieval is R6.3)
    allowPluralYou: boolean;        // 你们 present in trigger or context
    isObjectReact: boolean;         // image/mface trigger with short/no text caption
    isBotStatusContext: boolean;    // bot/禁言/策略 keywords in trigger or context
    isBurst: boolean;               // ≥5 msgs in 15s window
    isRelay: boolean;               // relay chain detected (vote/claim/echo)
    isDirect: boolean;              // @bot or reply-to-bot
    riskFlags: string[];            // e.g. ['admin-command-skipped', 'ambiguous-target']
  }
}
```

### `ExpectedAct` values

| Value | Trigger condition |
|-------|-------------------|
| `relay` | relay chain detected (扣1, +1, claim, echo) |
| `conflict_handle` | insult/conflict keywords in trigger or context |
| `summarize` | summarize keywords + conversation history ≥ 20 messages |
| `bot_status_query` | bot-referent (@bot) + status keywords |
| `meta_admin_status` | status keywords but not direct @bot |
| `object_react` | pure image/mface or short-caption image, no known-fact term |
| `direct_chat` | @bot or reply-to-bot (after above guards) |
| `chime_in` | multi-speaker conversation, reply-worthy |

### Weak Label Precedence (first match wins)

1. Admin slash command → skip (out of benchmark scope, flagged in `riskFlags`)
2. Relay pattern → `expectedAct=relay`
3. Conflict signals → `expectedAct=conflict_handle`
4. Summarize keywords + history ≥ 20 → `expectedAct=summarize`
5. Bot-referent + status keywords → `bot_status_query` (if @bot) / `meta_admin_status` (else)
6. Pure image/mface, no known-fact term → `expectedAct=object_react`
7. `isDirect` (not caught above) → `expectedAct=direct_chat`
8. Multi-speaker, reply-worthy → `expectedAct=chime_in, expectedDecision=reply`
9. Single-speaker or empty → `expectedAct=chime_in, expectedDecision=silent`

---

## `summary.json` — Shape

```ts
{
  generatedAt: string;          // ISO 8601 UTC timestamp
  samplingSeed: string;         // hex seed for reproduction
  sourceDb: string;             // absolute path of source DB (audit trail)
  totalSampled: number;
  totalLabeled: number;

  perCategory: {
    [category: SamplingCategory]: {
      sampled: number;
      labeled: number;
      target: number;           // --per-category-target value used
    }
  };

  duplicateRate: {
    byContentHash: number;      // fraction 0.0–1.0 of rows sharing content hash
    duplicateCount: number;     // absolute count
  };

  dataQuality: {
    emptyContent: number;
    malformedRows: number;
    missingContext: number;     // rows where triggerContext.length < 5
    missingContextAfter: number; // rows where triggerContextAfter.length < 3
  };

  gaps: {
    undersampled: Array<{
      category: SamplingCategory;
      sampled: number;
      target: number;
      shortfall: number;        // target - sampled (only categories < 80% of target)
    }>;
  };
}
```

---

## Categories (`SamplingCategory`)

| Category | Detection logic |
|----------|----------------|
| `direct_at_reply` | `[CQ:at,qq=<botId>]` or `[CQ:reply,...]` in raw_content |
| `known_fact_term` | Any 2-gram/word token overlaps with `learned_facts.canonical_form` or `fact` |
| `rhetorical_banter` | Short message (≤60 chars) with banter patterns (哈哈哈, 确实, 好吧, 无语, etc.) |
| `image_mface` | Contains `[CQ:image,...]`, `[CQ:mface,...]`, or `[CQ:face,...]` |
| `bot_status_context` | 禁言/策略/机器人/bot/管理员 in trigger or 5-message context window |
| `burst_non_direct` | ≥5 messages in 15s window; trigger is NOT an @bot direct |
| `relay_repeater` | ≥2 peers in 30s window with matching vote/claim/echo pattern |
| `conflict_heat` | Insult/profanity keywords (滚/垃圾/妈的/etc.) in trigger or context |
| `normal_chime_candidate` | Multi-speaker (≥2 user IDs), no hotter category matched |
| `silence_candidate` | Single-speaker monologue (≥5 msgs from same user), or empty content |

**Assignment priority** (when a message matches multiple categories, first wins):
`direct_at_reply` → `known_fact_term` → `relay_repeater` → `conflict_heat` → `bot_status_context` → `image_mface` → `burst_non_direct` → `rhetorical_banter` → `silence_candidate` → `normal_chime_candidate`

---

## Context Window

- **Before**: 5 preceding messages (constant `CONTEXT_BEFORE = 5` in `scripts/eval/types.ts`)
- **After**: 3 following messages (constant `CONTEXT_AFTER = 3` in `scripts/eval/types.ts`)

Asymmetry is intentional: causation flows from past; aftermath is a sanity signal for R6.3 replay.

---

## Deterministic Seed

UUIDs and row sampling are deterministic given the same `--seed`:

```ts
// UUID per row:
sha256(`${seed}:${groupId}:${messageId}`) → uuid-format

// Sampling gate per row:
sha256(`${seed}:${groupId}:${messageId}`) → BigInt → float in [0,1)
```

Re-running with the same `--seed` and same source DB produces identical output.

---

## Running the Sampler

```bash
npx tsx scripts/eval/sample-benchmark.ts \
  --db-path /path/to/bot.db \
  --seed deadbeef01234567deadbeef01234567 \
  --per-category-target 250 \
  --output-dir data/eval \
  --bot-user-id <your-bot-qq-id>
```

Outputs land in `data/eval/` and are gitignored. Do NOT commit them.
