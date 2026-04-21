# DEV-READY: PR1 sticker-token-leak — send-guard-chain + sticker strip

## 1. File changes (exact list)

NEW:
- `src/utils/sticker-token-output-guard.ts` — pure `stripStickerTokens` predicate
- `src/utils/send-guard-chain.ts` — chain scaffold + types + `runSendGuardChain` + `stickerLeakGuard` + `buildSendGuards`
- `test/utils/sticker-token-output-guard.test.ts`
- `test/utils/send-guard-chain.test.ts`
- `test/modules/chat-sticker-leak.test.ts`
- `test/eval/violation-tags-sticker.test.ts`

MODIFY:
- `src/modules/chat.ts` — 13 text-bearing return sites wrapped (reply+fallback); 2 sticker-kind sites skipped
- `src/modules/deflection-engine.ts:152` `_validate` — add `sticker:\d+` reject
- `src/utils/chat-result.ts` — extend `silent` reasonCode union with `'sticker-leak-stripped'`
- `scripts/eval/violation-tags.ts` — add `sticker-token-leak` tag + predicate + ALL_VIOLATION_TAGS + DENOMINATOR_RULES + ProjectedRow flag
- `scripts/eval/replay-runner-core.ts` — project `stickerLeakFired` from `reasonCode === 'sticker-leak-stripped'`

## 2. TypeScript signatures

`src/utils/sticker-token-output-guard.ts`
```ts
const STRIP_RE = /<?sticker:\d+>?/gu;
const TOKEN_ONLY_RE = /^\s*<?sticker:\d+>?\s*$/u;
export function stripStickerTokens(text: string): {
  stripped: string;       // every token removed + .trim()
  hadToken: boolean;      // at least one match
  wasTokenOnly: boolean;  // original matched TOKEN_ONLY_RE
};
```

`src/utils/send-guard-chain.ts`
```ts
import type { GroupMessage } from '../adapter/napcat.js';

export interface SendGuardCtx {
  groupId: string;
  triggerMessage: GroupMessage;
  isDirect: boolean;
  resultKind: 'reply' | 'fallback' | 'sticker';
}

export type GuardResult =
  | { passed: true; text: string }
  | { passed: false; reason: string; replacement: 'silent' | 'neutral-ack' | 'deflection' };

export type SendGuard = (text: string, ctx: SendGuardCtx) => GuardResult;

// For-loop + early-return; NOT map/forEach/reduce. Each guard sees the text
// produced by the previous passing guard (i.e. `text` is threaded through).
export function runSendGuardChain(
  guards: readonly SendGuard[],
  text: string,
  ctx: SendGuardCtx,
): GuardResult;

export const stickerLeakGuard: SendGuard;
export function buildSendGuards(): SendGuard[]; // PR1 returns [stickerLeakGuard]
```

`stickerLeakGuard` semantics (PR1 = `silent` only):
- `ctx.resultKind === 'sticker'` → `{ passed:true, text }` (skip)
- `hadToken === false` → `{ passed:true, text }`
- `wasTokenOnly` OR `stripped.trim() === ''` → `{ passed:false, reason:'sticker-leak-stripped', replacement:'silent' }`
- partial strip (residual non-empty) → `{ passed:true, text: stripped.trim() }`

`src/utils/chat-result.ts`: append `'sticker-leak-stripped'` to the `silent` reasonCode union.

## 3. SQL / Schema
None. Pure in-memory. Replay flag derives from `reasonCode === 'sticker-leak-stripped'` in `replay-runner-core.ts` (R2.5 precedent).

## 4. Integration — 11 entry-points grep-verified

Verified against `src/modules/chat.ts` @ worktree HEAD (each confirmed as `return { kind:… }` ChatResult):

| Line | kind | Path | Chain? |
|------|------|------|--------|
| 1685 | reply | @-spam curse+ignore `phrase` | YES |
| 1713 | fallback | pure-at deflection (`atOnlyText`) | YES |
| 1767 | fallback | SF1 dampener-ack (`ack`) | YES |
| 2073 | reply | relay echo (`relayDetection.content`) | YES |
| 2161 | reply | react-path curse deflection | YES |
| 2162 | reply | react-path harass deflection | YES |
| 2163 | reply | react-path probe (identity) deflection | YES |
| 2166 | reply | react-path task/recite deflection | YES |
| 2168 | reply | react-path memory deflection | YES |
| 2172 | fallback | low-comprehension-direct confused deflection | YES |
| 2785 | sticker | sticker-token choice (`cqCode`) | SKIP (no text) |
| 2849 | reply | addressee-scope regen result | YES |
| 2907 | fallback | `<skip>` → at-fallback | YES |
| 3010 | sticker | sticker-first path (`cqCode`) | SKIP (no text) |
| 3041 | reply | main chat output `processed` | YES |

**NOTE**: Designer's row `2161-2168` = 5 distinct returns (curse 2161, harass 2162, probe 2163, task/recite 2166, memory 2168). Total: 15 return sites; **13 text-bearing** (to wrap) + 2 sticker (skip). Designer "11" counted the range as one. `adapter.send` in `router.ts` is admin/operator — NOT wrapped.

### Diff shape (applies to every text-bearing site)

```ts
// Before
return { kind: 'reply', text: someText, meta: metaBuilder.buildReply('direct'), reasonCode: 'engaged' };

// After
const guardResult = runSendGuardChain(
  buildSendGuards(),
  someText,
  { groupId, triggerMessage, isDirect: isDirectForGateBypass, resultKind: 'reply' },
);
if (!guardResult.passed) {
  this.logger.info({ groupId, reason: guardResult.reason, original: someText }, 'send_guard_blocked');
  metaBuilder.setGuardPath('post-process');
  return { kind: 'silent', meta: metaBuilder.buildBase('silent'), reasonCode: 'sticker-leak-stripped' };
}
return { kind: 'reply', text: guardResult.text, meta: metaBuilder.buildReply('direct'), reasonCode: 'engaged' };
```

`isDirect` ctx binding: use nearest in-scope `isDirect` / `isDirectForGateBypass` at each site (verified in-scope by Dev via surrounding block). Fallback sites: on fail, return `kind:'silent'` with `reasonCode:'sticker-leak-stripped'` (do not keep `kind:'fallback'`).

### deflection-engine.ts `_validate` (line 152)

```ts
// Insert immediately after existing `if (/[<>]/.test(text)) return null;` (line 156):
if (/sticker:\d+/.test(text)) return null;
```

## 5. Test contract (vitest)

### `test/utils/sticker-token-output-guard.test.ts`
Should-strip (each asserts `hadToken === true`, `stripped` matches expected, `wasTokenOnly` correct):
- `'sticker:18'` → `stripped:''`, `wasTokenOnly:true`
- `'<sticker:34>'` → `stripped:''`, `wasTokenOnly:true`
- `'  sticker:5  '` → `stripped:''`, `wasTokenOnly:true`
- `'some text sticker:29 more text'` → `stripped:'some text  more text'`, `wasTokenOnly:false`
- `'\n\nsticker:12\n'` → `stripped:''`, `wasTokenOnly:true`
- `'<sticker:1> yo <sticker:2>'` → `stripped:'yo'` (trimmed), `wasTokenOnly:false`

Must-NOT-strip (assert `hadToken === false`, `stripped === text` verbatim or trimmed):
- `''` (empty)
- `'hello world'` (pure natural text)
- `'用 sticker 回'` (word without digit suffix)
- `'[CQ:image,file=abc.jpg]'` (resolved CQ form)
- `'sticker:abc'` (non-digit; regex requires `\d+`)

### `test/utils/send-guard-chain.test.ts`
- Empty guards array → `{ passed: true, text: <input> }`
- Single guard pass → text threaded through
- First guard fails → returns that GuardResult; **spy on second guard confirms NOT called** (short-circuit)
- First guard pass (mutates text) → second guard receives mutated text (spy verifies arg)
- `stickerLeakGuard` with `ctx.resultKind === 'sticker'` → `passed: true` regardless of text (skip path)
- `stickerLeakGuard` with token-only text + `resultKind:'reply'` → `passed: false, replacement:'silent', reason:'sticker-leak-stripped'`
- `stickerLeakGuard` with partial-strip text → `passed: true, text: <stripped>`

### `test/modules/chat-sticker-leak.test.ts`
Integration — mock Claude / deflection cache. At minimum ≥4 distinct paths (main-chat 3041, pure-at 1713, dampener-ack 1767, react-deflection 2161-2168):
- Mock returns `'sticker:18'` / `'<sticker:34>'` → `kind:'silent'`, `reasonCode:'sticker-leak-stripped'`
- Mock returns partial `'haha <sticker:1>'` → `kind:'reply'`, `text:'haha'`
- Mock returns `'好啊'` → unchanged
- Sticker-first (3010) w/ valid sticker → `kind:'sticker'` unchanged (guard skipped)
- Deflection cache returning `'sticker:29'` → `_validate` rejects (returns null); verify chain backstops if `_validate` bypassed

### `test/eval/violation-tags-sticker.test.ts`
- `ProjectedRow { resultKind:'silent', reasonCode:'sticker-leak-stripped', … }` → `computeViolationTags` includes `'sticker-token-leak'`
- Other `reasonCode` values (`'guard'`, `'dampener'`, `'scope'`) do NOT emit `sticker-token-leak`
- `ALL_VIOLATION_TAGS` contains `'sticker-token-leak'`
- `DENOMINATOR_RULES['sticker-token-leak']` defined; denominator = any outcome (no category filter)

### diff summary
`violation-tags.ts`: append `'sticker-token-leak'` to `ViolationTag`/`ALL_VIOLATION_TAGS`; add `stickerLeakFired: boolean` to `ProjectedRow`; in `computeViolationTags` add `if (row.resultKind==='silent' && row.stickerLeakFired) tags.push('sticker-token-leak');`; `DENOMINATOR_RULES['sticker-token-leak']: () => true`.
`replay-runner-core.ts` `ProjectedRow` build: `stickerLeakFired: reasonCode === 'sticker-leak-stripped'`.

## 6. Acceptance + Reviewer spot-checks

Dev checklist (raw paste required):
- `npx tsc --noEmit` clean
- `npx tsc -p tsconfig.scripts.json` clean
- `npx vitest run test/utils/sticker-token-output-guard.test.ts test/utils/send-guard-chain.test.ts test/modules/chat-sticker-leak.test.ts test/eval/violation-tags-sticker.test.ts` all pass
- `npx vitest run` full suite: 3816 + N pass, 20 pre-existing fixture fails unchanged
- Replay mock run: `sticker-token-leak` count=0; `direct-at-silenced-by-timing` 0/48 unchanged; `silence_defer_compliance` ≥ 95%

Reviewer spot-checks (independent verify; copy into Reviewer task description):
1. `git diff --name-only master..HEAD -- src/modules/chat.ts` shows 13 text-bearing return sites all wrapped. `grep -c 'runSendGuardChain(' src/modules/chat.ts` ≥ 13.
2. `src/utils/send-guard-chain.ts` `runSendGuardChain` body is a `for (const guard of guards)` with `return` on fail — NOT `.map/.forEach/.reduce/.every`. Short-circuit verified by `test/utils/send-guard-chain.test.ts` spy assertion.
3. `scripts/eval/violation-tags.ts` `sticker-token-leak` predicate is `row.resultKind === 'silent' && row.stickerLeakFired`, where `stickerLeakFired = reasonCode === 'sticker-leak-stripped'`; tag write-site and guard fire share reasonCode as the single source of truth (no separate side-channel).

## Open questions resolved
- Naming frozen `stripStickerTokens` (no replace/fallback overload).
- Chain holds only `silent` outcome in PR1; PR2/PR4 append neutral-ack / deflection later — do not pre-wire.
- `13 text-bearing` vs Designer's "11": row 2161-2168 is 5 distinct returns. Dev MUST wrap each.
