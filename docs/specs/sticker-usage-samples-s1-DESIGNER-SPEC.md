# DESIGNER-SPEC — Sticker Usage Capture S1

## 1. Schema — `src/storage/schema.sql`

Add at end of file:

```sql
CREATE TABLE IF NOT EXISTS sticker_usage_samples (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id          TEXT    NOT NULL,
  sticker_key       TEXT    NOT NULL,
  sender_user_id    TEXT    NOT NULL,
  prev_msgs         TEXT    NOT NULL DEFAULT '[]',  -- JSON [{user_id,content,timestamp}]
  trigger_text      TEXT    NOT NULL DEFAULT '',
  reply_to_target   TEXT,                           -- resolved content of CQ:reply target, NULL if none
  act_label         TEXT,                           -- NULL until LLM resolves; updated async
  context_embedding BLOB,                           -- NULL until embedding resolves; updated async
  later_reactions   TEXT    NOT NULL DEFAULT '[]',  -- JSON [{type,count,sample_msg}]
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sus_group_key
  ON sticker_usage_samples(group_id, sticker_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sus_group_act
  ON sticker_usage_samples(group_id, act_label, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sus_null_embedding
  ON sticker_usage_samples(id) WHERE context_embedding IS NULL;
```

## 2. Migration — `src/storage/db.ts` `_runMigrations()`

- `CREATE TABLE IF NOT EXISTS` in schema.sql handles fresh installs (idempotent).
- Add try/catch ALTER guard for any column added after initial ship (same pattern as existing migrations).

## 3. Types — `src/storage/db.ts`

```ts
export interface StickerUsageSampleInsert {
  groupId: string;
  stickerKey: string;
  senderUserId: string;
  prevMsgs: Array<{ userId: string; content: string; timestamp: number }>;
  triggerText: string;
  replyToTarget: string | null;
  createdAt: number;
}

export interface StickerUsageSample extends StickerUsageSampleInsert {
  id: number;
  actLabel: string | null;
  contextEmbedding: number[] | null;
  laterReactions: LaterReaction[];
}

export interface LaterReaction {
  type: 'echo' | 'rebuttal' | 'meme-react' | 'silence';
  count: number;
  sampleMsg: string;
}
```

## 4. Repository interface + impl — `src/storage/db.ts`

```ts
export interface IStickerUsageSampleRepository {
  insert(row: StickerUsageSampleInsert): number;                          // returns new id
  setEmbedding(id: number, vec: number[]): void;
  setActLabel(id: number, label: string): void;
  findRecentForUpdate(groupId: string, sinceMs: number): StickerUsageSample[];
  updateLaterReactions(id: number, reactions: LaterReaction[]): void;
  count(groupId: string): number;
}
```

- `insert`: store `prev_msgs` / `later_reactions` as `JSON.stringify`.
- `setEmbedding`: store Float32Array buffer (`Buffer.from(new Float32Array(vec).buffer)`).
- `findRecentForUpdate`: `WHERE group_id=? AND created_at >= ?` — used by later-reaction scanner.
- `setActLabel`: separate from insert so act-label is updated async without re-reading row.

## 5. Act-label service — `src/modules/sticker-usage-capture.ts` (NEW)

- Cache: `Map<string, string>` keyed by `sha256(prevMsgsConcat + stickerKey)`. Hit → return immediately.
- Model: `gemini-2.5-flash`, `reasoning_effort: 'none'` (per `feedback_gemini_reasoning_effort_eos`).
- System prompt CACHED (static): classification instructions + label list.
- User turn: prev_msgs + sticker summary.
- Valid labels: `laugh | confused | mock | agree | reject | cute | shock | comfort | spam-unknown`.
- Fallback on any error → `'spam-unknown'`.
- Prompt: `"Classify the social act of sending this sticker into ONE of: laugh/confused/mock/agree/reject/cute/shock/comfort/spam-unknown\nRecent context:\n<prev_msgs>\nSticker description: <summary>\nOutput: ONE label only."`

## 6. Capture worker — `src/modules/sticker-usage-capture.ts`

### `captureUsageFromMessage(msg, groupId, db, embeddingService, actLabelService)`
1. Guard: `if (msg.userId === botUserId) return;`
2. `sticker_key` — extract from `msg.rawContent` CQ:image or CQ:mface code.
3. `prevMsgs` — query `messages` table: `WHERE group_id=? AND timestamp < msg.timestamp AND user_id != botUserId ORDER BY timestamp DESC LIMIT 5`.
4. `triggerText` — `prevMsgs[0]?.content ?? ''`.
5. `replyToTarget` — if `rawContent` matches `[CQ:reply,id=X]`, query `messages WHERE source_message_id=X`, return `content`; else `null`.
6. `id = db.stickerUsageSamples.insert({...})` — synchronous, immediate.
7. `void Promise.all([...])` — fire-and-forget async:
   - act label → `db.stickerUsageSamples.setActLabel(id, label)`
   - context embedding → `db.stickerUsageSamples.setEmbedding(id, vec)`

### Call site — `src/core/router.ts:475`
```ts
if (msg.rawContent.match(/\[CQ:(image|mface),/) && msg.userId !== botUserId) {
  await captureFromMessage(...);                // existing
  void captureUsageFromMessage(msg, groupId);  // new, fire-and-forget
}
```

## 7. Later-reaction worker — `src/modules/sticker-usage-capture.ts`

### `LaterReactionWorker.scan(groupId, db)`
- Query: `findRecentForUpdate(groupId, now - 120_000)`.
- For each row, fetch the next N=10 messages after `row.created_at`.
- Classify reactions:
  - `echo`: any msg `rawContent` matches same `sticker_key` CQ code.
  - `rebuttal`: content matches regex `/关你屁事|神经病|别戳啦|闹麻了|你有病吧/`.
  - `meme-react`: content matches regex `/笑死|草(?!莓)|awsl|绷不住|哈哈+/`.
  - `silence`: N msgs passed, none matched above — insert explicit silence entry.
- Call `db.stickerUsageSamples.updateLaterReactions(row.id, reactions)`.

### Trigger point
- Called from `chat.ts._recordOwnReply` (or adapter send hook) — async, no await.
- `timer.unref?.()` on any `setTimeout` used for deferred scanning (per `feedback_timer_unref.md`).

## 8. Test matrix (≥15 rows)

| # | Scenario | Expected |
|---|----------|----------|
| 1 | INSERT positive: image msg, 3 prev_msgs | row inserted, id>0, actLabel null initially |
| 2 | INSERT skip bot: userId===botUserId | 0 rows inserted |
| 3 | Later-reaction echo: same sticker in next 5 msgs | laterReactions=[{type:'echo',...}] |
| 4 | Later-reaction rebuttal: 神经病 in follow-up | laterReactions=[{type:'rebuttal',...}] |
| 5 | Later-reaction meme-react: 草 in follow-up | laterReactions=[{type:'meme-react',...}] |
| 6 | Later-reaction silence: 10 msgs, no match | laterReactions=[{type:'silence',...}] |
| 7 | repo.insert returns numeric id | typeof id === 'number' |
| 8 | repo.setEmbedding: Float32 round-trip | vec precision preserved |
| 9 | repo.setActLabel: updates col | row.actLabel === 'laugh' |
|10 | repo.findRecentForUpdate: sinceMs filter | only rows in window returned |
|11 | repo.updateLaterReactions: JSON round-trip | deep-equals input |
|12 | repo.count: group-scoped count | matches insert count |
|13 | Migration idempotent: schema twice | no error, row count unchanged |
|14 | Edge: CQ:reply resolves to target content | replyToTarget === msg content |
|15 | Edge: sticker is first msg | triggerText='', prevMsgs=[] |
|16 | Act label cache hit | LLM called exactly once for same hash |
|17 | Act label LLM fail | label === 'spam-unknown' |
|18 | Schema: no rejected/promoted cols | PRAGMA table_info excludes those cols |

## 9. Files

- `src/storage/schema.sql` — add table + indexes
- `src/storage/db.ts` — types + `IStickerUsageSampleRepository` + impl + ALTER guard
- `src/modules/sticker-usage-capture.ts` — NEW: act-label service + capture worker + `LaterReactionWorker`
- `src/core/router.ts` — add `void captureUsageFromMessage(...)` call at line ~475
- `test/modules/sticker-usage-capture.test.ts` — NEW
- `test/storage/sticker-usage-samples-repo.test.ts` — NEW
