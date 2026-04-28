# DEV-READY — Sticker Usage Capture S1

Read PLANNER-SPEC.md and DESIGNER-SPEC.md first. This doc resolves architect-level decisions, fixes designer/planner conflicts, and gives paste-ready edit blocks.

---

## §0 Architect Decisions (resolves Designer's open Qs + task #3 picks)

| # | Decision | Rationale |
|---|----------|-----------|
| A1 | **prev_msgs N = 5** | Per task #3 (more context for embedding); planner says 3-5; Designer's `LIMIT 5` matches. |
| A2 | **later-reactions N = 8** | Per task #3 ("balance noise/signal"). Designer wrote N=10 — **change to 8**. |
| A3 | **`created_at` unit = SECONDS** | Project convention (`router.ts` line 226 uses `Math.floor(Date.now() / 1000)`). Designer's `findRecentForUpdate(sinceMs)` is **misnamed** — rename to `findRecentForUpdate(groupId, sinceSec)`. Per `feedback_timing_unit_consistency_across_tables.md`. |
| A4 | **Later-reaction window = 120 SECONDS** (= 2 min). Caller passes `nowSec - 120`. | Same unit as schema. |
| A5 | **Trigger point: router.ts, after capture call.** Do NOT touch `chat.ts._recordOwnReply`. | chat.ts is part of the read-path; zero-diff requirement. Router already has `this.db`, runs on every msg, no awaiting. |
| A6 | **Standalone module `sticker-usage-capture.ts`** (not extension of `StickerCaptureService`). | Easier to test in isolation; clean wiring; matches Designer §9 file list. |
| A7 | **Embedding BLOB encoding: `new Uint8Array(new Float32Array(vec).buffer)`** | Matches existing pattern in `local_stickers` (db.ts:2408). Designer's `Buffer.from(...)` works but breaks consistency. |
| A8 | **`prev_msgs` query EXCLUDES bot user_id** | Per Designer §6.3. Captures group conversational context — bot self-quotes pollute the signal. Also excludes the sticker sender's own message at that exact timestamp (use `<` not `<=`). |
| A9 | **`reply_to_target` format**: store as `${nickname}: ${content}` if available, else `${userId}: ${content}` | Single human-readable string per planner. NULL if reply target row not found. |
| A10 | **Act-label cache key: `sha256(prev_msgs concat + sticker_key)` truncated to 32 hex chars** | Designer §5 says hash; truncate for in-process Map keys. |
| A11 | **Act-label call uses `IClaudeClient.complete()` with `REFLECTION_MODEL`** | Existing pattern (diary-distiller, self-reflection). ModelRouter already routes `gemini-*` to GeminiClient. No new client wiring. |
| A12 | **LLM act-label is fire-and-forget; if not configured (no claude in DI), label remains NULL forever** | Same pattern as `StickerCaptureService` (claude is optional). Backfill workers can be added in a future sprint. |
| A13 | **Bot-source sticker check: `userId === botUserId` BEFORE any work** | Per planner + `feedback_phrase-miner-skip-bot-output`. Skip applies to BOTH the new `captureUsageFromMessage` call AND the existing `captureFromMessage` for completeness — but existing call already has the guard at line 185 of sticker-capture.ts. New code re-implements the guard at the top of `captureUsageFromMessage`. |
| A14 | **No `setActLabel` and `setEmbedding` in same SQL UPDATE** | They resolve at independent times (one is LLM-bound, the other embedding-bound). Two separate UPDATE statements per Designer §4. |

---

## §1 Edit Blocks — Paste-Ready

Files touched: 6 (5 src + 2 test files).

### 1.1 `src/storage/schema.sql` — APPEND at end of file (after `learned_facts` related blocks, before any final view/trigger blocks)

```sql

-- S1: sticker usage samples — captures human sticker sends with surrounding
-- conversation slice for future Q2 (usage-context retrieval). Capture only;
-- no read-path consumer in this sprint.
CREATE TABLE IF NOT EXISTS sticker_usage_samples (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id          TEXT    NOT NULL,
  sticker_key       TEXT    NOT NULL,
  sender_user_id    TEXT    NOT NULL,
  prev_msgs         TEXT    NOT NULL DEFAULT '[]',
  trigger_text      TEXT    NOT NULL DEFAULT '',
  reply_to_target   TEXT,
  act_label         TEXT,
  context_embedding BLOB,
  later_reactions   TEXT    NOT NULL DEFAULT '[]',
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sus_group_key
  ON sticker_usage_samples(group_id, sticker_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sus_group_act
  ON sticker_usage_samples(group_id, act_label, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sus_null_embedding
  ON sticker_usage_samples(id) WHERE context_embedding IS NULL;
```

### 1.2 `src/storage/db.ts` — `_runMigrations()` ADD block (per `feedback_sqlite_schema_migration.md`)

Inside `_runMigrations()`, add a new `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` block (mirroring the `learned_facts` and `live_stickers` patterns at db.ts:3556 and 3581). Schema.sql `CREATE TABLE IF NOT EXISTS` covers fresh installs but legacy DBs created before this column-set need this branch.

```ts
    // S1: sticker_usage_samples — repeated for upgrade-in-place on legacy DBs
    // that predate the schema. See feedback_sqlite_schema_migration.md.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS sticker_usage_samples (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id          TEXT    NOT NULL,
        sticker_key       TEXT    NOT NULL,
        sender_user_id    TEXT    NOT NULL,
        prev_msgs         TEXT    NOT NULL DEFAULT '[]',
        trigger_text      TEXT    NOT NULL DEFAULT '',
        reply_to_target   TEXT,
        act_label         TEXT,
        context_embedding BLOB,
        later_reactions   TEXT    NOT NULL DEFAULT '[]',
        created_at        INTEGER NOT NULL
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_sus_group_key ON sticker_usage_samples(group_id, sticker_key, created_at DESC)`);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_sus_group_act ON sticker_usage_samples(group_id, act_label, created_at DESC)`);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_sus_null_embedding ON sticker_usage_samples(id) WHERE context_embedding IS NULL`);
```

### 1.3 `src/storage/db.ts` — types + interface (place near `ILocalStickerRepository`)

```ts
export interface StickerUsageSampleInsert {
  groupId: string;
  stickerKey: string;
  senderUserId: string;
  prevMsgs: Array<{ userId: string; content: string; timestamp: number }>;
  triggerText: string;
  replyToTarget: string | null;
  createdAt: number;  // SECONDS (project convention)
}

export type LaterReactionType = 'echo' | 'rebuttal' | 'meme-react' | 'silence';

export interface LaterReaction {
  type: LaterReactionType;
  count: number;
  sampleMsg: string | null;
}

export interface StickerUsageSample extends StickerUsageSampleInsert {
  id: number;
  actLabel: string | null;
  contextEmbedding: number[] | null;
  laterReactions: LaterReaction[];
}

export interface IStickerUsageSampleRepository {
  insert(row: StickerUsageSampleInsert): number;
  setEmbedding(id: number, vec: number[]): void;
  setActLabel(id: number, label: string): void;
  /** sinceSec: lower bound on created_at (inclusive). SECONDS — matches schema. */
  findRecentForUpdate(groupId: string, sinceSec: number): StickerUsageSample[];
  updateLaterReactions(id: number, reactions: LaterReaction[]): void;
  count(groupId: string): number;
}
```

### 1.4 `src/storage/db.ts` — implementation `StickerUsageSampleRepository`

Place near `LocalStickerRepository` (around line 2280). Add `readonly stickerUsageSamples: IStickerUsageSampleRepository;` to the `Database` class fields (near line 3430), and instantiate in the constructor (near where `localStickers` is created).

```ts
class StickerUsageSampleRepository implements IStickerUsageSampleRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(row: StickerUsageSampleInsert): number {
    const result = this.db.prepare(
      `INSERT INTO sticker_usage_samples
         (group_id, sticker_key, sender_user_id, prev_msgs, trigger_text, reply_to_target, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.groupId,
      row.stickerKey,
      row.senderUserId,
      JSON.stringify(row.prevMsgs),
      row.triggerText,
      row.replyToTarget,
      row.createdAt,
    );
    return Number(result.lastInsertRowid);
  }

  setEmbedding(id: number, vec: number[]): void {
    const buf = new Uint8Array(new Float32Array(vec).buffer);
    this.db.prepare(
      `UPDATE sticker_usage_samples SET context_embedding = ? WHERE id = ?`,
    ).run(buf, id);
  }

  setActLabel(id: number, label: string): void {
    this.db.prepare(
      `UPDATE sticker_usage_samples SET act_label = ? WHERE id = ?`,
    ).run(label, id);
  }

  findRecentForUpdate(groupId: string, sinceSec: number): StickerUsageSample[] {
    const rows = this.db.prepare(
      `SELECT * FROM sticker_usage_samples
       WHERE group_id = ? AND created_at >= ?
       ORDER BY created_at ASC`,
    ).all(groupId, sinceSec) as unknown as Array<{
      id: number; group_id: string; sticker_key: string; sender_user_id: string;
      prev_msgs: string; trigger_text: string; reply_to_target: string | null;
      act_label: string | null; context_embedding: ArrayBuffer | Uint8Array | null;
      later_reactions: string; created_at: number;
    }>;
    return rows.map(r => ({
      id: r.id,
      groupId: r.group_id,
      stickerKey: r.sticker_key,
      senderUserId: r.sender_user_id,
      prevMsgs: JSON.parse(r.prev_msgs) as Array<{ userId: string; content: string; timestamp: number }>,
      triggerText: r.trigger_text,
      replyToTarget: r.reply_to_target,
      actLabel: r.act_label,
      contextEmbedding: r.context_embedding ? Array.from(new Float32Array(r.context_embedding instanceof Uint8Array ? r.context_embedding.buffer : r.context_embedding)) : null,
      laterReactions: JSON.parse(r.later_reactions) as LaterReaction[],
      createdAt: r.created_at,
    }));
  }

  updateLaterReactions(id: number, reactions: LaterReaction[]): void {
    this.db.prepare(
      `UPDATE sticker_usage_samples SET later_reactions = ? WHERE id = ?`,
    ).run(JSON.stringify(reactions), id);
  }

  count(groupId: string): number {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM sticker_usage_samples WHERE group_id = ?`,
    ).get(groupId) as { cnt: number } | undefined;
    return r?.cnt ?? 0;
  }
}
```

### 1.5 `src/modules/sticker-usage-capture.ts` — NEW

Single file containing: act-label service, capture worker, later-reaction worker, sticker-key extraction (shared via static helpers from `StickerCaptureService` to avoid duplicate regex).

```ts
import { createHash } from 'node:crypto';
import type { ClaudeModel, IClaudeClient } from '../ai/claude.js';
import type { IEmbeddingService } from '../storage/embeddings.js';
import type {
  IMessageRepository,
  IStickerUsageSampleRepository,
  LaterReaction,
  StickerUsageSample,
} from '../storage/db.js';
import { REFLECTION_MODEL } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { StickerCaptureService } from './sticker-capture.js';

const logger = createLogger('sticker-usage-capture');

const VALID_LABELS = new Set([
  'laugh', 'confused', 'mock', 'agree', 'reject', 'cute', 'shock', 'comfort', 'spam-unknown',
]);

const REBUTTAL_RE = /关你屁事|神经病|别戳啦|闹麻了|你有病吧/;
// Negative lookahead avoids matching '草莓'. '哈哈+' requires at least 2 hahas.
const MEME_RE = /笑死|草(?!莓)|awsl|绷不住|哈哈+/;

const ACT_LABEL_CACHE = new Map<string, string>();
const ACT_LABEL_CACHE_MAX = 2000;

export interface StickerUsageCaptureOptions {
  claude?: IClaudeClient;
  embedder?: IEmbeddingService;
  /** Override REFLECTION_MODEL for tests. */
  actLabelModel?: string;
  /** prev_msgs LIMIT (default 5). */
  prevN?: number;
}

export class StickerUsageCaptureService {
  private readonly claude: IClaudeClient | null;
  private readonly embedder: IEmbeddingService | null;
  private readonly actLabelModel: string;
  private readonly prevN: number;

  constructor(
    private readonly repo: IStickerUsageSampleRepository,
    private readonly messages: IMessageRepository,
    options: StickerUsageCaptureOptions = {},
  ) {
    this.claude = options.claude ?? null;
    this.embedder = options.embedder ?? null;
    this.actLabelModel = options.actLabelModel ?? REFLECTION_MODEL;
    this.prevN = options.prevN ?? 5;
  }

  /** Resolve sticker key from CQ:image (sub_type=1) or CQ:mface raw content. */
  static extractStickerKey(rawContent: string): string | null {
    const mfaces = StickerCaptureService.extractMfaces(rawContent);
    if (mfaces.length > 0 && mfaces[0]) return mfaces[0].key;
    const imgFile = StickerCaptureService.extractImageStickerFile(rawContent);
    if (imgFile) return `img:${imgFile}`;
    return null;
  }

  /** Capture a usage sample. Fire-and-forget. Skips bot-source. */
  captureUsageFromMessage(
    msg: { groupId: string; userId: string; rawContent: string; timestamp: number; nickname?: string },
    botUserId: string,
  ): void {
    if (msg.userId === botUserId) return;
    const stickerKey = StickerUsageCaptureService.extractStickerKey(msg.rawContent);
    if (!stickerKey) return;

    // Sync work: query prev_msgs, resolve reply, INSERT.
    const prevAll = this.messages.getRecent(msg.groupId, this.prevN + 5);
    const prev = prevAll
      .filter(m => m.timestamp < msg.timestamp && m.userId !== botUserId && m.content.trim().length > 0)
      .slice(0, this.prevN)
      .reverse();  // chronological
    const triggerText = prev.length > 0 ? (prev[prev.length - 1]?.content ?? '') : '';

    let replyToTarget: string | null = null;
    const r = msg.rawContent.match(/\[CQ:reply,id=(\d+)\]/);
    if (r && r[1]) {
      const target = this.messages.findBySourceId(r[1]);
      if (target) replyToTarget = `${target.userId}: ${target.content}`;
    }

    const id = this.repo.insert({
      groupId: msg.groupId,
      stickerKey,
      senderUserId: msg.userId,
      prevMsgs: prev.map(p => ({ userId: p.userId, content: p.content, timestamp: p.timestamp })),
      triggerText,
      replyToTarget,
      createdAt: msg.timestamp,
    });

    // Async fire-and-forget: act label + embedding. No await.
    void this._resolveActLabel(id, prev.map(p => p.content), stickerKey)
      .catch(err => logger.warn({ err, id }, 'act-label resolve failed — labelled spam-unknown'));
    void this._resolveEmbedding(id, prev.map(p => p.content).join(' ') + (triggerText ? ' ' + triggerText : ''))
      .catch(err => logger.warn({ err, id }, 'context embedding failed'));
  }

  private async _resolveActLabel(id: number, prevTexts: string[], stickerKey: string): Promise<void> {
    if (!this.claude) return;  // not configured — leave NULL
    const cacheKey = createHash('sha256')
      .update(prevTexts.join('|') + '\n' + stickerKey)
      .digest('hex')
      .slice(0, 32);
    const cached = ACT_LABEL_CACHE.get(cacheKey);
    if (cached) {
      this.repo.setActLabel(id, cached);
      return;
    }

    const system = `Classify the social act of sending a sticker into ONE of: laugh, confused, mock, agree, reject, cute, shock, comfort, spam-unknown. Output ONE label only — no punctuation, no explanation.`;
    const user = `Recent context (chronological):\n${prevTexts.join('\n') || '(none)'}\n\nSticker key: ${stickerKey}\n\nLabel:`;

    let label: string;
    try {
      const resp = await this.claude.complete({
        model: this.actLabelModel as ClaudeModel,
        system: [{ text: system }],
        messages: [{ role: 'user', content: user }],
        maxTokens: 16,
      });
      const cleaned = resp.text.trim().toLowerCase().replace(/[^a-z\-]/g, '');
      label = VALID_LABELS.has(cleaned) ? cleaned : 'spam-unknown';
    } catch {
      label = 'spam-unknown';
    }

    if (ACT_LABEL_CACHE.size >= ACT_LABEL_CACHE_MAX) {
      const firstKey = ACT_LABEL_CACHE.keys().next().value;
      if (firstKey !== undefined) ACT_LABEL_CACHE.delete(firstKey);
    }
    ACT_LABEL_CACHE.set(cacheKey, label);
    this.repo.setActLabel(id, label);
  }

  private async _resolveEmbedding(id: number, text: string): Promise<void> {
    if (!this.embedder?.isReady) return;
    if (text.trim().length < 2) return;
    const vec = await this.embedder.embed(text);
    this.repo.setEmbedding(id, vec);
  }

  /** Test-only escape hatch. */
  static _resetCacheForTests(): void { ACT_LABEL_CACHE.clear(); }
}

/** Later-reactions classifier. Stateless — DB-only. */
export class LaterReactionWorker {
  /** Window in seconds (default 120 = 2min). */
  static readonly WINDOW_SEC = 120;
  /** Number of subsequent messages to inspect (per Architect A2). */
  static readonly N_FOLLOWUPS = 8;

  constructor(
    private readonly repo: IStickerUsageSampleRepository,
    private readonly messages: IMessageRepository,
  ) {}

  /** Scan + update all rows in window. Idempotent — re-runs overwrite. */
  scan(groupId: string, nowSec: number): void {
    const since = nowSec - LaterReactionWorker.WINDOW_SEC;
    const rows = this.repo.findRecentForUpdate(groupId, since);
    for (const row of rows) {
      const reactions = this._classify(row);
      this.repo.updateLaterReactions(row.id, reactions);
    }
  }

  private _classify(row: StickerUsageSample): LaterReaction[] {
    const followups = this.messages.getAroundTimestamp(
      row.groupId, row.createdAt, LaterReactionWorker.WINDOW_SEC, 64,
    ).filter(m => m.timestamp > row.createdAt)
      .slice(0, LaterReactionWorker.N_FOLLOWUPS);

    let echoCount = 0, rebuttalCount = 0, memeCount = 0;
    let echoSample: string | null = null;
    let rebuttalSample: string | null = null;
    let memeSample: string | null = null;

    for (const f of followups) {
      const fKey = StickerUsageCaptureService.extractStickerKey(f.rawContent);
      if (fKey === row.stickerKey) {
        echoCount += 1;
        echoSample ??= f.content || `[sticker ${fKey}]`;
      }
      if (REBUTTAL_RE.test(f.content)) {
        rebuttalCount += 1;
        rebuttalSample ??= f.content;
      }
      if (MEME_RE.test(f.content)) {
        memeCount += 1;
        memeSample ??= f.content;
      }
    }

    const out: LaterReaction[] = [];
    if (echoCount > 0) out.push({ type: 'echo', count: echoCount, sampleMsg: echoSample });
    if (rebuttalCount > 0) out.push({ type: 'rebuttal', count: rebuttalCount, sampleMsg: rebuttalSample });
    if (memeCount > 0) out.push({ type: 'meme-react', count: memeCount, sampleMsg: memeSample });
    if (out.length === 0 && followups.length >= 2) {
      out.push({ type: 'silence', count: followups.length, sampleMsg: null });
    }
    return out;
  }
}
```

### 1.6 `src/core/router.ts` — single-line addition near line 482

After the existing `this.stickerCapture.captureFromMessage(...)` call, add **inside the same `if (this.stickerCapture && msg.rawContent.match(...))` block**:

```ts
        // S1: usage-context capture (separate from meta capture above). Fire-and-forget.
        if (this.stickerUsageCapture && msg.userId !== (this.botUserId ?? '')) {
          try {
            this.stickerUsageCapture.captureUsageFromMessage(msg, this.botUserId ?? '');
          } catch (err) {
            this.logger.warn({ err, groupId: msg.groupId }, 'sticker usage capture failed');
          }
        }
        // S1: later-reactions scan — runs every msg, idempotent, no-op when no rows in window.
        if (this.laterReactionWorker) {
          try {
            this.laterReactionWorker.scan(msg.groupId, Math.floor(Date.now() / 1000));
          } catch (err) {
            this.logger.warn({ err, groupId: msg.groupId }, 'later-reaction scan failed');
          }
        }
```

DI wiring (constructor + field declaration in `Router` class, mirror `stickerCapture` field at line 239):

```ts
private readonly stickerUsageCapture: StickerUsageCaptureService | null = null;
private readonly laterReactionWorker: LaterReactionWorker | null = null;
```

Provide setter or constructor inject (whichever pattern Router currently uses for `stickerCapture` — Dev: mirror it). DEV: use the same pattern that wires `stickerCapture` (look at Router constructor or `setStickerCapture(...)` helper).

### 1.7 Tests — `test/storage/sticker-usage-samples-repo.test.ts` (NEW)

Mirror `learned-facts-dedup.test.ts` skeleton. Cases (Designer #7-13):
- repo.insert returns numeric id, row roundtrip via raw SELECT
- repo.setEmbedding: Float32 round-trip via `findRecentForUpdate` then assert vec length + first/last element
- repo.setActLabel: idempotent UPDATE, single row affected
- repo.findRecentForUpdate: rows outside `sinceSec` excluded; rows at boundary inclusive
- repo.updateLaterReactions: deep-equal JSON round-trip
- repo.count: group-scoped
- migration idempotent: `new Database()` twice on same file path → no error, count unchanged

### 1.8 Tests — `test/modules/sticker-usage-capture.test.ts` (NEW)

Cases (Designer #1-6, #14-18):
- INSERT positive: image msg, 3 prev_msgs → row inserted, actLabel resolves to expected via mock claude
- INSERT skip bot: senderUserId === botUserId → 0 rows
- prev_msgs N boundary: exactly 5 (extra msgs trimmed)
- prev_msgs N boundary: fewer than 5 available → all available stored, no error
- Edge: sticker is first msg in group (no prev) → triggerText='', prevMsgs=[]
- Edge: CQ:reply,id=X resolves via `findBySourceId` → replyToTarget contains target content
- Edge: CQ:reply,id=X with no matching message → replyToTarget=null
- LaterReaction echo: same sticker_key in next 5 msgs
- LaterReaction rebuttal: 神经病 in follow-up
- LaterReaction meme-react: 草 in follow-up; 草莓 must NOT match (negative lookahead)
- LaterReaction silence: 8 follow-ups, none matching
- LaterReaction window: row older than 120s ignored
- Act-label cache hit: same prev+key → claude.complete called once
- Act-label LLM fail: claude.complete throws → label='spam-unknown'
- Act-label invalid output: claude returns 'banana' → label='spam-unknown' (validates against VALID_LABELS)
- Embedding service not ready → context_embedding stays NULL
- No claude configured → actLabel stays NULL

---

## §2 Verification (run from worktree root)

```
cd D:/QQ-Group-Bot/.claude/worktrees/sticker-usage-samples-s1-capture
npx tsc --noEmit
npx tsc -p tsconfig.scripts.json
npx vitest run test/modules/sticker-usage-capture.test.ts
npx vitest run test/storage/sticker-usage-samples-repo.test.ts
npx vitest run
```

Architect prototype (already validated, 7/7 pass):
```
node scripts/r6-sticker-s1-verify.mjs
```
Output:
```
[verify] migration idempotent check…
  ok
[verify] seeded 24 messages.
[verify] skip-bot-source: bot sticker not inserted — ok
[verify] prev_msgs JSON shape — ok
[verify] reply_to_target resolution — ok
[verify] context_embedding BLOB shape — ok
[verify] later-reactions: echo/rebuttal/meme/silence all classified — ok
[verify] act_label class membership — ok
[verify] ALL ASSERTIONS PASSED — schema + capture + later-reactions verified.
```

---

## §3 Reviewer 6-item Checklist

1. **Spec 1:1 mapping**: schema columns, prev_msgs N=5, later-reactions N=8, window=120s, all 4 reaction types, act_label 9-class output (8 + spam-unknown).
2. **Skip-bot-source**: `userId === botUserId` guards in (a) `captureUsageFromMessage` top, (b) router.ts call site. Test asserts 0 rows for bot stickers.
3. **Schema migration idempotent**: `_runMigrations()` uses `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`; 2nd run no-op. Test runs `new Database(path)` twice → same row count.
4. **Async fire-and-forget**: capture path = sync INSERT only; act-label + embedding via `void promise.catch(...)`. No `await` in router call. Capture sync time bounded by single-row INSERT + 1 prev_msgs SELECT.
5. **Read-path zero diff**: `git diff master -- src/modules/sticker-first.ts src/utils/stickers.ts src/modules/chat.ts` MUST be empty for sticker section assembly. Only chat.ts is modified IF Dev mistakenly hooks LaterReactionWorker there — DON'T. Trigger from router only (per A5).
6. **Scope hygiene**: No edits to sticker-first scorer, no per-user style code, no read-path consumers of `sticker_usage_samples` (only writer).

---

## §4 Dev pre-commit step

```
rm -f scripts/r6-sticker-s1-verify.mjs
```

Architect prototype is throwaway — must NOT land in commit. Confirm with `git status` after.

---

## §5 Commit message

```
feat(sticker): S1 — sticker_usage_samples capture worker (usage context + act label + later-reactions, no behavior change)
```

---

## §6 Out of scope (S1)

- Sticker-first scorer changes (S3)
- Offline replay over historical messages (S2)
- Per-user sticker style modeling
- Cross-group corpus aggregation
- Read-path retrieval (Q2 read; S2 will consume these rows)
- Admin UI / CLI / metrics dashboard

---

## §7 PR body

```
## Summary

S1 of the sticker usage modeling track: capture-only infrastructure for Q2 (usage-context retrieval).

Per `feedback_modality_use_when_not_what.md`, modality retrieval needs both Q1 (instance content — already shipped via summary embedding) and Q2 (usage context — what conversational moment this sticker landed in). This PR ships the data plumbing for Q2 only; the scorer is unchanged.

- New table `sticker_usage_samples` with 5 row inserted per human sticker send: prev_msgs (5 chronological), trigger_text, reply_to_target, act_label (gemini-2.5-flash, 8 classes + spam-unknown fallback), context_embedding (existing IEmbeddingService), later_reactions (8-msg / 120-sec window classifier: echo / rebuttal / meme-react / silence).
- Skip-bot-source: `senderUserId === botUserId` excluded.
- Async fire-and-forget for label + embedding; main message routing not blocked.
- Read-path `sticker-first.ts` / `buildStickerSection` / chat.ts sticker assembly **zero diff vs master**.

## No behavior change at flag-default

This PR only writes; no consumer reads `sticker_usage_samples`. Sticker-first scoring path is untouched. S2 (offline replay) and S3 (scorer integration) will consume these rows.

## Test plan

- [ ] `npx tsc --noEmit` — 0 errors
- [ ] `npx tsc -p tsconfig.scripts.json` — 0 errors
- [ ] `npx vitest run test/modules/sticker-usage-capture.test.ts` — pass
- [ ] `npx vitest run test/storage/sticker-usage-samples-repo.test.ts` — pass
- [ ] Full suite `npx vitest run` — pass
- [ ] Manual: bot sticker → no row; user sticker → row with prev_msgs, async fields update within seconds.
```

---

## §8 Open-question resolutions (for record)

| From | Q | Resolution |
|------|---|------------|
| Designer §72 | Standalone vs extend `StickerCaptureService` | Standalone — A6 |
| Designer §76 | prev_msgs source: DB or in-memory | DB via `messages` repo — authoritative — A8 |
| Designer §78 | Later-reaction scan: per-msg vs periodic | **Per-msg** — A5 (avoids timer; idempotent; rows outside window auto-skipped by `findRecentForUpdate`) |
| Designer §80 | Gemini cached system prompt | Static `system` array passed to `IClaudeClient.complete()`; provider-side caching is a Gemini SDK concern out of scope. CACHE-HIT in this PR = local in-process Map (A10). |
| Task #3 | LLM act label sync vs mock-LLM in test | **Mock LLM in test** (deterministic). Production = async. |
| Task #3 | prev N | **5** (A1) |
| Task #3 | later-reactions N | **8** (A2) |
| Task #3 | embedding service | Reuse `IEmbeddingService` — A11 |
| Task #3 | reply-to | `messages.findBySourceId` (db.ts:1176 confirmed exists) |
| Task #3 | cache key | `sha256(prev concat \| sticker_key)[:32]` — A10 |

---

## §9 FLAGS for team-lead

None. Designer + Planner aligned with one resolvable conflict (later-reactions N=10 vs task#3 N=8 — Architect chose 8 per task #3) and one unit-naming bug (designer's `sinceMs` parameter for `findRecentForUpdate` — renamed to `sinceSec`). Both fixed in §0 decision table.

DEV-READY done. Prototype 7/7 passing.
