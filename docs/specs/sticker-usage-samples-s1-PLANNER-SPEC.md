# Feature: Sticker Usage Modeling S1 — Capture Infrastructure

## Product Context

The bot currently selects stickers by matching the *what* (sticker content/summary embedding vs. conversation text).
It does not learn *when* group members use a sticker — the social/emotional moment that makes a sticker land.
S1 lays the data foundation for Q2 (usage-context retrieval): record every human sticker send with its surrounding
conversation slice, a lightweight act label, and a later-reactions signal. No scorer changes this sprint.

## User Stories

- As the bot system, I want to record what conversation preceded each human sticker send so future sprints can
  retrieve "stickers used in moments like this one."
- As the bot system, I want a lightweight act label per sample so downstream modeling has a coarse signal without
  waiting for full Q2 retrieval.
- As the bot system, I want to observe how the group reacted after a sticker so we can score social success.

## Acceptance Criteria

- [ ] `sticker_usage_samples` table exists with all columns from the schema in the task description; existing DBs
      are migrated via `ALTER TABLE` in db.ts (per project rule: schema.sql CREATE is a no-op on live DBs).
- [ ] Every human sticker or mface send (image sub_type=1 OR mface) is recorded: prev_msgs (3-5 msgs, JSON),
      trigger_text (single most recent text msg), reply_to_target (resolved if CQ:reply present), created_at (sec).
- [ ] Bot-originated stickers are skipped (senderUserId === botUserId).
- [ ] act_label is populated asynchronously via cheap LLM (gemini-2.5-flash, cached system prompt, ~50 tokens).
      8 classes: laugh / confused / mock / agree / reject / cute / shock / comfort. Unknown/failed → `spam-unknown`.
- [ ] context_embedding is populated asynchronously by reusing the existing `IEmbeddingService` interface on the
      concatenation of prev_msgs + trigger_text.
- [ ] later_reactions JSON is updated within a 2-minute window after each captured row. Four reaction types:
      echo (same sticker_key re-sent), rebuttal (短攻击/纠正 pattern), meme-react (笑死/草/awsl class),
      silence (no relevant response in window).
- [ ] All async work (label + embedding + later_reactions) fires via fire-and-forget; capture path does not block
      message routing.
- [ ] New service is wired into `router.ts` at the existing `captureFromMessage` call site without altering the
      sticker-first scorer path.
- [ ] Unit tests cover: table migration idempotency, bot-skip guard, prev_msgs slice boundary (N=3 and N=5),
      later_reactions update for each of the 4 types, act_label fallback to spam-unknown on LLM failure.
- [ ] `tsc --noEmit` passes. Vitest suite passes.

## Scope

**Included:**
- New `sticker_usage_samples` table + ALTER migration
- Capture service extension (extend `StickerCaptureService` or new `StickerUsageSampler` service)
- act_label async LLM call (gemini-2.5-flash; reuse existing Gemini HTTP client)
- context_embedding async call (reuse `IEmbeddingService`)
- later_reactions update loop (scan rows ≤2 min old on each incoming message)
- Wire-up in router.ts
- Unit tests for the above

**Excluded:**
- Sticker-first scorer changes (S3)
- Offline replay over historical messages (S2)
- Per-user sticker preference modeling
- Cross-group corpus analysis
- Admin UI or CLI for browsing samples
- Any change to `buildStickerSection` or `getStickerPool`

## Edge Cases to Test

- **Bot sticker skip**: message with senderUserId === botUserId must produce zero rows.
- **prev_msgs boundary**: fewer than 3 msgs in history → store what's available (no error).
- **No reply_to**: reply_to_target stays NULL; no crash.
- **LLM timeout / error**: act_label falls back to `spam-unknown`; row still persisted.
- **Embedding service not ready**: context_embedding stays NULL; partial index `idx_sus_null_embedding` used for
  backfill later.
- **Rapid sticker flood** (same group, 3 stickers in 10s): each gets its own row; no dedup.
- **later_reactions window expiry**: rows older than 2 min are not updated again.
- **Duplicate same sticker_key in reactions window**: echo count increments, not duplicate rows.
- **Mface with no summary attr**: capture proceeds; trigger_text and prev_msgs still recorded.

## Open Questions

1. Should `StickerUsageSampler` be a standalone service injected separately, or a method added to
   `StickerCaptureService`? (Architect decides — both are valid; standalone is easier to test in isolation.)
2. What is the exact prev_msgs source? `messages` table (last N by timestamp DESC) or the in-memory recent-messages
   slice already passed to `captureFromMessage`? (Architect decides — DB read is authoritative; in-memory is faster.)
3. later_reactions scan: triggered on every incoming message vs. on a periodic tick? (Architect decides — per-message
   scan avoids a timer; periodic tick decouples the hot path.)
4. Gemini HTTP client: does the existing client support a cached system prompt, or does Architect need to add
   `system_instruction` caching support first?
