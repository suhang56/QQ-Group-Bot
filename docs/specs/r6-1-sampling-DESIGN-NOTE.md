# R6.1 Sampling — Design Note

## 1. `benchmark-raw.jsonl` — Per-row Schema

Each line is a JSON object. All fields required unless noted.

```ts
{
  id: string;                  // UUID v4, stable across re-runs for same (groupId+messageId)
  groupId: string;             // QQ group ID (string, not number — avoids JS precision loss)
  messageId: string;           // source message ID from messages table
  userId: string;              // sender QQ ID
  nickname: string;            // sender display name at sample time
  timestamp: number;           // Unix epoch seconds (integer) — matches messages table unit
  content: string;             // processed/display content (CQ codes stripped or resolved)
  rawContent: string;          // raw message content exactly as stored in DB
  triggerContext: ContextMsg[]; // 5 preceding messages (oldest first)
  triggerContextAfter: ContextMsg[]; // 3 following messages (oldest first)
  category: SamplingCategory;  // one of 10 enum values (see §4)
  samplingSeed: string;        // hex string of the RNG seed used for this run
}

interface ContextMsg {
  messageId: string;
  userId: string;
  nickname: string;
  timestamp: number;           // Unix epoch seconds
  content: string;
  rawContent: string;
}

type SamplingCategory =
  | 'direct_at_reply'
  | 'known_fact_term'
  | 'rhetorical_banter'
  | 'image_mface'
  | 'bot_status_context'
  | 'burst_non_direct'
  | 'relay_repeater'
  | 'conflict_heat'
  | 'normal_chime_candidate'
  | 'silence_candidate';
```

## 2. `benchmark-weak-labeled.jsonl` — Per-row Schema

Each line is the raw row above **plus** a `label` field:

```ts
{
  // ...all fields from benchmark-raw.jsonl...

  label: WeakReplayLabel;
}

interface WeakReplayLabel {
  expectedAct:
    | 'direct_chat'
    | 'chime_in'
    | 'conflict_handle'
    | 'summarize'
    | 'bot_status_query'
    | 'relay'
    | 'meta_admin_status'
    | 'object_react';
  expectedDecision: 'reply' | 'silent' | 'defer';
  hasKnownFactTerm: boolean;   // true if any trigger token hits learned_facts
  hasRealFactHit: boolean;     // R6.1: set equal to hasKnownFactTerm (no runtime chat path)
  allowPluralYou: boolean;     // true if 你们 is acceptable (multi-target context)
  isObjectReact: boolean;      // image/mface/sticker trigger
  isBotStatusContext: boolean; // 禁言/策略/机器人 in trigger or context window
  isBurst: boolean;            // ≥5 msgs in 15s window
  isRelay: boolean;            // 接龙/扣1/duplicate content within 30s
  isDirect: boolean;           // @ or reply-to-bot
  riskFlags: string[];         // e.g. ['legacy-few-shot-possible', 'ambiguous-target']
}
```

## 3. `summary.json` — Shape

```ts
{
  generatedAt: string;         // ISO 8601 UTC, e.g. "2026-04-19T10:00:00.000Z"
  samplingSeed: string;        // same hex seed as rows
  sourceDb: string;            // absolute path of the DB file sampled (for auditability)
  totalSampled: number;        // total rows in benchmark-raw.jsonl
  totalLabeled: number;        // total rows in benchmark-weak-labeled.jsonl (≤ totalSampled)

  perCategory: {
    [category in SamplingCategory]: {
      sampled: number;         // rows in raw file
      labeled: number;         // rows that got a label (should equal sampled for R6.1)
      target: number;          // configured target (200–300)
    };
  };

  duplicateRate: {
    byContentHash: number;     // 0.0–1.0 fraction of rows sharing content hash with another
    duplicateCount: number;    // absolute count of duplicate-content rows
  };

  dataQuality: {
    emptyContent: number;      // rows where content === ''
    malformedRows: number;     // rows that failed schema validation at write time
    missingContext: number;    // rows where triggerContext.length < 5 (near table start)
    missingContextAfter: number; // rows where triggerContextAfter.length < 3 (near table end)
  };

  gaps: {
    // categories that came in under 80% of target
    undersampled: Array<{
      category: SamplingCategory;
      sampled: number;
      target: number;
      shortfall: number;
    }>;
  };
}
```

## 4. Context Window Size — 5 Before + 3 After

**Recommendation: `triggerContext` = 5 preceding, `triggerContextAfter` = 3 following.**

Justification:
- **5 before**: Enough to detect burst (5-msg/15s window starts exactly at boundary), relay chains (30s lookback), topic freshness, and multi-speaker context. Going to 7+ adds noise without new signal for rule-based labelers.
- **3 after**: Sufficient to detect whether bot reply was warranted (did conversation continue or drop?). R6.3 replay runner needs aftermath context. 3 is the minimum for silence validation; 5 would pull in off-topic drift.
- **Asymmetry is intentional**: causation flows from past; aftermath is a sanity signal only.
- Both counts are config constants in `scripts/eval/types.ts` (`CONTEXT_BEFORE = 5`, `CONTEXT_AFTER = 3`) so R6.3 can adjust without schema migration.

## 5. `.gitignore` Additions

Add these two lines to repo root `.gitignore`:

```
data/eval/*.jsonl
data/eval/*.json
```

**Do NOT add `data/eval/`** (entire directory). Rationale:
- `data/eval/fixtures/` may later contain small synthetic fixtures that should be committed (R6.2+ gold set tooling).
- Wildcard patterns on `*.jsonl` and `*.json` ignore all live output files while leaving the directory tracked and subdirectories committable.
- If a `data/eval/.gitkeep` is needed to track the empty dir, it is not matched by these patterns and will commit correctly.
