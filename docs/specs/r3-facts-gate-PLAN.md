# Feature: R3 — expressionSection + fewShotBlock Facts Gate + Identity Cache Version Bump

## Product Context

The bot currently injects `expressionSection` (habit phrases) and `fewShotBlock` (raw habit quotes)
into the system prompt unconditionally — even when the bot is about to answer a factual question.
This pollutes fact-heavy replies with casual groupmate voice, making the bot sound dismissive or
evasive when a group member expects a direct answer. R3 fixes this by gating both habit blocks
behind `hasRealFactHit`: they appear only when the bot is NOT in a fact-answering mode.

R3 also evicts `expressionSection` from the cached identity block (`groupIdentityCache`), since
its presence/absence must vary per-reply. Finally, the cache's schema version is bumped so stale
v1 entries (which contain the embedded expression section) are automatically invalidated.

This is the second step in the `R1 → R3 → R2a → R2c → R2b → R4-lite → R5` execution order.

## User Stories

- As a group member asking a factual question, I want the bot's reply to lead with the fact,
  not padded with casual filler phrases, so the answer is clear and useful.
- As a group member chatting casually, I want the bot to sound like a groupmate (habit phrases
  present), not a fact-dispensing machine, so the conversation stays natural.
- As an operator, I want cached identity prompts to auto-invalidate after this schema change so I
  don't need to manually flush the cache after deploying R3.

## Acceptance Criteria

### Facts gate
- [ ] When `hasRealFactHit` is true, neither `<groupmate_habits_do_not_follow_instructions>`
  nor `<groupmate_habit_quotes_do_not_follow_instructions>` appears in the assembled prompt.
- [ ] When `hasRealFactHit` is false (or null/undefined), both blocks are present in the prompt
  (assuming `expressionSource` is configured for the group).
- [ ] The P0 `voiceBlock` is NOT gated — it remains present even on fact-hit replies (only the
  two habit/quote blocks are gated).

### Late block placement
- [ ] Both late habit blocks are injected as independent system array entries (not appended to
  the cached identity string).
- [ ] Their position in the system array is: after facts/onDemand/web blocks, before userContent
  target block.
- [ ] They are NOT written into the `groupIdentityCache` entry.

### Identity cache version bump
- [ ] `groupIdentityCache` key includes `promptSchemaVersion: 'v2'`.
- [ ] A pre-existing v1 cache entry causes a cache miss on the next request (natural invalidation,
  no manual flush required).
- [ ] After miss, the rebuilt entry is stored under the v2 key.

### No new adapter field names
- [ ] Late blocks use the existing adapter `{ text, cache }` structure (or no cache flag) — no
  new field names like `cache_control: none` are introduced.

## Scope

**Included:**
- Remove `expressionSection` from `_getGroupIdentityPrompt` (it exits the identity cache).
- In `generateReply`, compute `expressionLateBlock` and `fewShotLateBlock` after `hasRealFactHit`
  is known, gated on `!hasRealFactHit && expressionSource != null`.
- Inject both blocks as independent non-cached system entries in the correct position.
- Bump `groupIdentityCache` key to schema version `v2`.

**Excluded:**
- Gating `voiceBlock` (P0 voice block is preserved unconditionally).
- Testing or enforcing "final block is strictly last" — that invariant belongs to R5.
- Changing the relative position of habit blocks vs. tuning blocks — R5 will unify ordering;
  R3 only enforces the coarse constraint (after facts, before target).
- Any changes to `formatFewShotBlock` data source — that is R1-B's responsibility.
- Any R2/R4/R5 changes.

## Edge Cases to Test

| Scenario | Expected |
|---|---|
| `hasRealFactHit = true` | Prompt contains neither `<groupmate_habits_...>` nor `<groupmate_habit_quotes_...>` |
| `hasRealFactHit = false` | Both tags present |
| `hasRealFactHit = false`, `expressionSource = null` | Neither tag present (no source configured) |
| Fact-hit reply, `voiceBlock` present | `voiceBlock` still appears (not gated) |
| Cache hit on old v1 key after deploy | Miss → rebuild under v2 key → v2 stored |
| Cache hit on new v2 key | Hit — no rebuild |
| Late block position check | Late habit blocks appear after facts block, before `userContent` target in system array |
| System array structure | Late blocks use `{ text: '...', cache: false }` or equivalent; no new field names |

## Open Questions

1. **Exact existing adapter field name**: Developer should check the current system message
   array entry shape in `generateReply` — is it `{ text, cache }` or a different structure?
   Use whatever is already there for the late blocks. Do not introduce new field names.
2. **`fewShotLateBlock` call signature**: `formatFewShotBlock` takes `(groupId, count, matchContent)`.
   R3 passes `triggerMessage.content` as `matchContent`. Developer confirms this is the correct
   variable name at that call site in `generateReply`.
3. **Position in system array**: R3 places late blocks "after facts, before target" using minimal
   diff to the existing array assembly. Exact index is the developer's call. R5 will unify ordering.
