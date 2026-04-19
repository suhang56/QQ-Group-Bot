# R3 Facts Gate — DEV-READY

Branch: `feat/r3-facts-gate` (worktree at `D:/QQ-Group-Bot/.claude/worktrees/r3-facts-gate/`)

---

## Summary

Three surgical edits to `src/modules/chat.ts`. No other files changed.

1. Remove `expressionSection` from `_getGroupIdentityPrompt` (evict from cached identity string).
2. In `generateReply`, build two late blocks after `hasRealFactHit` is known and inject them gated on `!hasRealFactHit`.
3. Bump the `groupIdentityCache` key from plain `groupId` to `${groupId}:v2`.

---

## Edit 1 — Remove `expressionSection` from `_getGroupIdentityPrompt`

File: `src/modules/chat.ts`

### Delete the block (lines 4365–4373 current):

```ts
    // M6.2a / P3: expression-learner — groupmate habits (reads groupmate_expression_samples by default).
    // TODO(P3): skip block when hasRealFactHit=true (facts crowd out habit hints).
    // Threading hasRealFactHit here requires restructuring the generateReply pipeline since
    // _getGroupIdentityPrompt is called before hasRealFactHit is computed (line ~2062 vs ~2449).
    const expressionSection = (() => {
      if (!this.expressionSource) return '';
      const text = this.expressionSource.formatForPrompt(groupId);
      return text ? `\n\n${text}` : '';
    })();
```

### Also remove `expressionSection` from the assembled `text` string (line 4452):

The current assembly is:
```ts
    const text = `${personaBase}${adminStyleSection}${loreSection}${jargonSection}${honestGapsSection}${groupStyleSection}${expressionSection}${relationshipSection}${diarySection}${rulesBlock}${imageAwarenessLine}\n\n---\n...`;
```

Replace with:
```ts
    const text = `${personaBase}${adminStyleSection}${loreSection}${jargonSection}${honestGapsSection}${groupStyleSection}${relationshipSection}${diarySection}${rulesBlock}${imageAwarenessLine}\n\n---\n...`;
```

(`expressionSection` is removed; all other variables are unchanged.)

---

## Edit 2 — Bump `groupIdentityCache` key to v2

File: `src/modules/chat.ts`

The cache uses `groupId` as the Map key. Change every `.get(groupId)` / `.set(groupId, ...)` / `.delete(groupId)` that refers to `groupIdentityCache` to use `${groupId}:v2` instead.

**Locations** (by current line numbers, verify before editing):

| Line | Current | Replace with |
|------|---------|--------------|
| 4277 | `this.groupIdentityCache.get(groupId)` | `this.groupIdentityCache.get(`${groupId}:v2`)` |
| 4314 | `this.groupIdentityCache.delete(groupId)` | `this.groupIdentityCache.delete(`${groupId}:v2`)` |
| 4458 | `this.groupIdentityCache.set(groupId, ...)` | `this.groupIdentityCache.set(`${groupId}:v2`, ...)` |

Also search for other `groupIdentityCache` references outside `_getGroupIdentityPrompt` — currently at lines 1514, 1524, 1533 (invalidation calls on config/persona change events). These also need the `:v2` suffix so invalidation still hits the correct entry:

| Line | Current | Replace with |
|------|---------|--------------|
| 1514 | `this.groupIdentityCache.delete(groupId)` | `this.groupIdentityCache.delete(`${groupId}:v2`)` |
| 1524 | `this.groupIdentityCache.delete(groupId)` | `this.groupIdentityCache.delete(`${groupId}:v2`)` |
| 1533 | `this.groupIdentityCache.delete(groupId)` | `this.groupIdentityCache.delete(`${groupId}:v2`)` |

> **Note**: The Map type stays `Map<string, { text: string; expiresAt: number }>` — no type change needed since the key is still a string.

---

## Edit 3 — Inject `expressionLateBlock` and `fewShotLateBlock` in `generateReply`

File: `src/modules/chat.ts`

### 3a. Build the late blocks

Insert immediately after `hasRealFactHit` is computed (after line 2457, before `voiceBlock` build at line 2460):

```ts
    // R3: expression habit blocks evicted from identity cache; injected here
    // so they can be gated on hasRealFactHit.
    const expressionLateBlock = (!hasRealFactHit && this.expressionSource)
      ? this.expressionSource.formatForPrompt(groupId)
      : '';
    const fewShotLateBlock = (!hasRealFactHit && this.expressionSource)
      ? this.expressionSource.formatFewShotBlock(groupId, 3, triggerMessage.content)
      : '';
```

### 3b. Remove the unconditional `fewShotBlock` computation

The current block at lines 2386–2388:
```ts
    const fewShotBlock = this.expressionSource
      ? this.expressionSource.formatFewShotBlock(groupId, 3, triggerMessage.content)
      : '';
```

Delete this — `fewShotLateBlock` from step 3a replaces it.

### 3c. Inject into the non-hardened `system[]` array

Current non-hardened path (lines 2530–2543):
```ts
        : [
            { text: systemPrompt, cache: true },
            { text: STATIC_CHAT_DIRECTIVES, cache: true },
            { text: variantBlock, cache: true },
            ...(groupContextBlock ? [{ text: groupContextBlock, cache: true as const }] : []),
            ...(moodSection ? [{ text: moodSection, cache: true as const }] : []),
            ...(contextStickerSection ? [{ text: contextStickerSection, cache: true as const }] : []),
            ...(rotatedStickerSection ? [{ text: rotatedStickerSection, cache: true as const }] : []),
            ...(factsBlock ? [{ text: factsBlock, cache: true as const }] : []),
            ...(onDemandFactBlock ? [{ text: onDemandFactBlock, cache: false }] : []),
            ...(webLookupBlock ? [{ text: webLookupBlock, cache: false }] : []),
            ...(tuningBlock ? [{ text: tuningBlock, cache: true as const }] : []),
            ...(fewShotBlock ? [{ text: fewShotBlock, cache: true as const }] : []),
          ],
```

Replace with (two late blocks added after `webLookupBlock`, before `tuningBlock`; `fewShotBlock` → `fewShotLateBlock`):
```ts
        : [
            { text: systemPrompt, cache: true },
            { text: STATIC_CHAT_DIRECTIVES, cache: true },
            { text: variantBlock, cache: true },
            ...(groupContextBlock ? [{ text: groupContextBlock, cache: true as const }] : []),
            ...(moodSection ? [{ text: moodSection, cache: true as const }] : []),
            ...(contextStickerSection ? [{ text: contextStickerSection, cache: true as const }] : []),
            ...(rotatedStickerSection ? [{ text: rotatedStickerSection, cache: true as const }] : []),
            ...(factsBlock ? [{ text: factsBlock, cache: true as const }] : []),
            ...(onDemandFactBlock ? [{ text: onDemandFactBlock, cache: false }] : []),
            ...(webLookupBlock ? [{ text: webLookupBlock, cache: false }] : []),
            ...(expressionLateBlock ? [{ text: expressionLateBlock, cache: false }] : []),
            ...(fewShotLateBlock ? [{ text: fewShotLateBlock, cache: false }] : []),
            ...(tuningBlock ? [{ text: tuningBlock, cache: true as const }] : []),
          ],
```

> `fewShotBlock` entry removed; two new `cache: false` entries added after web/ondemand blocks, before tuning.
> Hardened path is unchanged — it never had expression/fewShot blocks.

---

## Tests Required (BLOCKER — must be written before implementation ships)

New test file: `test/chat-r3-facts-gate.test.ts`

The test file should use the same mock/stub pattern as `test/chat-expression-wiring.test.ts` (mock `expressionSource` inline, not via full `ChatModule` construction).

Cover every row in the spec edge-case table:

| # | Test name | Setup | Assert |
|---|-----------|-------|--------|
| 1 | `hasRealFactHit=true → no habit tags in system[]` | `hasRealFactHit=true`, `expressionSource` returns non-empty | Neither `<groupmate_habits_do_not_follow_instructions>` nor `<groupmate_habit_quotes_do_not_follow_instructions>` appears in any assembled system block |
| 2 | `hasRealFactHit=false → both habit tags present` | `hasRealFactHit=false`, `expressionSource` returns non-empty | Both tags appear in the assembled system array |
| 3 | `hasRealFactHit=false, expressionSource=null → no tags` | `expressionSource=null` | Neither tag present |
| 4 | `voiceBlock present on fact-hit reply` | `hasRealFactHit=true`, `groupmateVoice` returns non-empty | `voiceBlock.text` non-empty in userContent (voiceBlock not gated) |
| 5 | `cache miss on v1 key after deploy` | Prime cache under old key `groupId` (no suffix), then call `_getGroupIdentityPrompt` | New key `${groupId}:v2` is stored; old key is NOT used for cache hit |
| 6 | `cache hit on v2 key` | Prime cache under `${groupId}:v2`, call again | Returns cached text without rebuilding |
| 7 | `late block position: after facts, before userContent` | Inspect assembled `system[]` array order | Index of `expressionLateBlock` > index of `factsBlock` entry; no entry after it is `factsBlock` |
| 8 | `late blocks use cache: false` | `hasRealFactHit=false`, `expressionSource` non-empty | Both late block entries have `cache: false` (not `cache: true`) |

> Tests 1–4 and 7–8 can be unit-tested against the block-assembly logic directly (extract a helper or test via mock `claude.complete` capture). Tests 5–6 test `_getGroupIdentityPrompt` directly (it is `private` — use a test-subclass or `(chat as any)._getGroupIdentityPrompt(...)` pattern consistent with existing tests).

---

## Invariants to Preserve

- `voiceBlock` is built unconditionally (line 2460 block unchanged).
- `tuningBlock` remains after the late blocks (char-mode suppression unchanged).
- Hardened path (`hardened=true`) is not modified — it never injected expression blocks.
- The `fewShotBlock` variable name is gone; `fewShotLateBlock` is the replacement. If any other code path references `fewShotBlock`, update those too (grep first).
- `expressionSource.formatFewShotBlock` call signature: `(groupId, 3, triggerMessage.content)` — unchanged from the original line 2387.

---

## Diff Size Estimate

~30 lines changed in `src/modules/chat.ts`. No schema migrations, no new files (other than the test file).
