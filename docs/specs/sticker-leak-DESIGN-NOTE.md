# DESIGN-NOTE: PR1 sticker-token-leak — send-guard-chain + sticker strip

## Q1: SendGuardCtx fields (exact TS interface)

```ts
export interface SendGuardCtx {
  groupId: string;          // required: logging + tag emission
  triggerMessage: GroupMessage; // required: replay tag origin
  isDirect: boolean;        // required: sticker-guard may differ on DM vs group
  resultKind: 'reply' | 'fallback' | 'sticker'; // required: guard aware of ChatResult.kind
  // metaBuilder: deferred to PR2+ — not needed for sticker strip
}
```

`recentMessages` deferred to PR2 (harassment ceiling needs window; sticker guard does not).

## Q2: GuardResult replacement semantics (PR1 scope only)

- `silent` — strip text entirely; do NOT send anything. PR1 sticker guard always resolves here.
- `neutral-ack` — downgrade to `NEUTRAL_ACK_POOL` (`['嗯','在','?','咋了','啥']`) from `direct-cooldown.ts:97`. Reserved for PR2+ guards.
- `deflection` — route to deflection pool. Reserved for PR4.

**PR1 uses `silent` only.** No neutral-ack, no replacement text.

## Q3: Send entry-points in chat.ts (all ChatResult return sites)

| Line | Kind | Path |
|------|------|------|
| 1685 | reply | engaged (direct) |
| 1713 | fallback | pure-at deflection |
| 1767 | fallback | dampener-ack |
| 2073 | reply | relay chain echo |
| 2161-2168 | reply | react-path deflections (curse/harass/probe/recite/task/memory) |
| 2172 | fallback | low-comprehension-direct |
| 2785 | sticker | sticker-token path |
| 2849 | reply | scope-regen |
| 2907 | fallback | at-fallback |
| 3010 | sticker | sticker-first |
| 3041 | reply | main chat output |

**Total: 11 return points.** All `text`-bearing kinds (`reply`, `fallback`) must pass through chain. `sticker` kind (lines 2785, 3010) carries `cqCode` not `text` — chain skips these; no sticker token can be in `cqCode` by construction.

`adapter.send` in **router.ts** (lines 535–1706) is admin/moderation — operator text, not LLM output — guard does NOT wrap these.

## Q4: deflection-engine.ts `_validate` — add sticker rejection?

**Yes, add one line.** Cheaper to reject at cache-write than let chain strip at send time.

```ts
if (/sticker:\d+/.test(text)) return null;  // reject protocol token at cache-write
```

Chain remains primary defense. `_validate` is cheap pre-filter only — no replacement here.

## Regex spec (exact forms for Architect)

```ts
// detect-only (single match, no global flag):
const STICKER_TOKEN_RE = /<?sticker:\d+>?/u;

// strip-all (replaceAll, with global flag):
const STICKER_TOKEN_STRIP_RE = /<?sticker:\d+>?/gu;

// whole-string token-only check (for silent-vs-send decision):
const STICKER_TOKEN_ONLY_RE = /^\s*<?sticker:\d+>?\s*$/u;
```

After `replaceAll`: if result `.trim() === ''` → `GuardResult { action: 'silent' }`.

## Must-NOT-fire scenarios

1. **Pure natural text** — no `sticker:\d+` pattern → chain does not touch, passes through unchanged.
2. **Word "sticker" in natural language** — `"用 sticker 回"` — no digit suffix, regex does not match.
3. **Bot quoting user message** — guard applies to outgoing `text` only (new bot reply text, not echo of inbound content); same principle as PR2 incoming-message exemption.
4. **CQ-code sticker already resolved** — `[CQ:image,file=...]` format has no `sticker:\d+` pattern → not matched.
5. **fact-hit path existing guard** — chain short-circuits first-fail; already-guarded paths must not regress. Covered by existing `test/modules/chat-sticker-leak.test.ts` suite.
6. **Multi-sticker partial strip** — `"cool <sticker:1> yeah"` → strip tokens → `"cool  yeah"` (trimmed non-empty) → `{ action: 'pass', text: 'cool yeah' }`, NOT silent.
