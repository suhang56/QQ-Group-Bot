# DESIGN-NOTE: R2a — Timing Gate Frontload + `_classifyPath` Preview

## Surface: Type enum

```typescript
export type PathKind = 'hard-bypass' | 'ultra-light' | 'timing-gated' | 'direct';
```

## Surface: `_classifyPath` signature

```typescript
// Pure function — zero DB write / cooldown write / send / LLM / state mutation
function _classifyPath(msg: GroupMessage, ctx: ClassifyCtx): PathKind
// ClassifyCtx = { isAtMention: boolean; isReplyToBot: boolean; isCommand: boolean; commandName: string | null; relayDetection: RelayDetection | null }
```

- Inputs sourced from values already computed before this call site (no new DB reads inside fn)
- Returns enum value only — caller branches on result

## Surface: Insertion point in router.ts

- Hard-bypass and ultra-light branches splice in **before line 680** (`let skipStickerFirst = ...`)
- Exact position: immediately after the `isAtMention`/`isReplyToBot` locals at lines 634–638
- Direct path (`isAtMention === true`) already branches at line 673 → `_enqueueAtMention`; `_classifyPath` runs only on the `else` branch (line 675+)
- Proposed order inside the `else` block:
  1. `const pathKind = _classifyPath(msg, { isAtMention, isReplyToBot, ... })` — line ~676 (new)
  2. `if (pathKind === 'hard-bypass') { await handler(msg,...); return; }` — line ~677 (new)
  3. `if (pathKind === 'ultra-light') { /* relay/repeater path — skip timing gate */ goto chatModule }` — line ~678 (new)
  4. `if (pathKind === 'direct') { await _enqueueAtMention(...); return; }` — line ~679 (new, covers reply-to-bot direct)
  5. Existing `skipStickerFirst` / sticker-first block (lines 680–717) — unchanged
  6. Existing `evaluatePreGenerate` timing gate (lines 719+) — unchanged; only reached for `'timing-gated'`

## Surface: Hard-bypass command list

Sourced from `_registerCommands()` (line 2166) + DM command block. Commands that are admin/mod actions — timing gate must not defer them:

| Command | Registered at | Admin-only? |
|---|---|---|
| `rule_add` | 2500 | yes |
| `rule_false_positive` | 2636 | yes |
| `add` | 2523 | open (openCmds set) |
| `add_stop` | 2545 | open |
| `add_block` | 2551 | yes |
| `add_unblock` | 2566 | yes |
| `fact_reject` | 2670 | open |
| `fact_clear` | 2684 | open |
| `fact_approve` | 2768 | yes |
| `fact_approve_all` | 2782 | yes |
| `appeal` | 2462 | open |
| `stickerfirst_on/off` | 2825/2841 | yes |
| `sticker_ban` | 2880 | yes |
| `lore_refresh` | 2581 | yes |
| `/bot_status` (DM) | 1963 | yes (MOD_APPROVAL_ADMIN) |

- Detection: `peekCmd` already computed at line 523; reuse same `trimmed.startsWith('/') && commands.has(peekCmd)` predicate
- No new exported predicate needed — inline `this.commands.has(cmd)` check inside `_classifyPath` (pass `commandName` via ctx)

## Surface: Ultra-light qualification

- **relay** (`relay-detector.ts`): `detectRelay()` is a pure sync function (no DB, no side effects) — qualifies as preview-safe
- **repeater** (`src/core/router.ts:1268–1270`): `_shouldRepeat()` — Architect must confirm purity (grep `this.db` / `this.adapter` inside it)
- **mimic_on active path** (lines 630–665): calls `this.mimicModule.generateMimic()` which is async + LLM-backed — NOT ultra-light; remains timing-gated
- Ultra-light = relay echo/vote/claim OR repeater only; mimic stays timing-gated

## Surface: Direct override signal

- Reuse existing `isAtMention` (line 634) and `isReplyToBot` (line 636) — both already computed before the insertion point
- Pass via `ClassifyCtx`; do NOT recompute inside `_classifyPath`
- `isReplyToBot` at line 636 uses `recentMsgs.some(m => m.userId === this.botUserId)` — already available

## Surface: Preview purity contract (M5)

- `_classifyPath` takes only primitives + `RelayDetection | null` (already computed by `detectRelay`)
- Snapshot test pattern: call `_classifyPath` 100x with same args; assert no changes to `deferQueue.size()`, `db.*`, `adapter.send` call count, cooldown map entries
- Test uses vitest spy on `this.db` write methods + `this.adapter.send` — assert call count === 0 after 100 invocations

## Surface: Pino log event shapes

| PathKind | event name | payload keys |
|---|---|---|
| `hard-bypass` | `'path-classifier:hard-bypass'` | `{ groupId, cmd, userId }` |
| `ultra-light` | `'path-classifier:ultra-light'` | `{ groupId, relayKind, userId }` |
| `timing-gated` | `'path-classifier:timing-gated'` | `{ groupId, userId, msgId }` |
| `direct` | `'path-classifier:direct'` | `{ groupId, userId, signal: 'at'|'reply' }` |

- Log level: `debug` for all four (non-production noise)
- Caller logs after branching; `_classifyPath` itself emits nothing (keeps it pure-ish and testable without logger injection)

## Open questions for Architect

1. **Q1 (PLAN OQ1)** — module placement: `_classifyPath` inline in `router.ts` vs `src/core/path-classifier.ts`. Designer defers to Architect; both are valid. Inline reduces import surface; separate file improves isolated snapshot test.
2. **Q2 (PLAN OQ4)** — repeater purity: Architect must grep `_shouldRepeat` for `this.db` / `this.adapter` calls to confirm ultra-light eligibility.
3. **Q3 (PLAN OQ5)** — mimic LLM vs local: `mimic_on` active path calls `generateMimic()` (LLM). `/mimic` command = hard-bypass (it's a slash command). `mimic_on` lurker path = timing-gated. Designer recommends this split; Architect confirms.

## Conflicts with existing convention

- NONE found. Existing `isDirect` flag in `evaluatePreGenerate` (line 729) uses `false` for organic path — R2a does not touch that call; it bypasses the gate earlier for direct/ultra-light/hard-bypass.
