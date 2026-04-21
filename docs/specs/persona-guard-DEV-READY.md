# DEV-READY: PR4 persona-fabrication-guard

Worktree: `.claude/worktrees/persona-guard/`. Branch: `fix/identity-persona-guard`. Base: PR1/PR2 merged.

## §1 Files

NEW:
- `src/utils/identity-deflections.ts` — const source-of-truth (breaks cycle; §4.0)
- `src/utils/persona-fabrication-guard.ts` — guard + predicate + patterns + picker
- `test/utils/persona-fabrication-guard.test.ts`
- `test/utils/send-guard-chain.persona.test.ts` (3-guard short-circuit)
- `test/eval/violation-tags-persona.test.ts`
- `test/modules/chat-identity-probe-extended.test.ts`

MODIFY:
- `src/modules/chat.ts:329` — replace literal with re-export from `identity-deflections.js`
- `src/modules/chat.ts:306-307` — extend `IDENTITY_PROBE` (append 4 groups, §4.2)
- `src/utils/send-guard-chain.ts:57` — append `personaFabricationGuard` to `buildSendGuards()`
- `src/utils/chat-result.ts:33` — silent reasonCode union `+ 'persona-fabricated'`
- `scripts/eval/violation-tags.ts` — 2 tags + 2 `ProjectedRow` fields + 2 `DENOMINATOR_RULES`
- `scripts/eval/replay-runner-core.ts:267` — project 2 flags
- `scripts/eval/replay-summary.ts:133` — project 2 flags

## §2 TS signatures

`src/utils/identity-deflections.ts`:
```ts
export const IDENTITY_DEFLECTIONS: readonly string[] = [
  '啊？', '什么', '？？', '?', '啧',
  '问这个干嘛', '别研究这个', '自己猜', '不告诉你',
] as const;
```

`src/utils/persona-fabrication-guard.ts`:
```ts
import type { SendGuard } from './send-guard-chain.js';
import { IDENTITY_DEFLECTIONS } from './identity-deflections.js';
import { stripCqReply } from './output-hard-gate.js';
export const BLOCKED_SELF_ATTR_PATTERNS: readonly RegExp[];
export function hasSelfPersonaFabrication(text: string): boolean;
export function pickPersonaDeflection(): string;
export const personaFabricationGuard: SendGuard;
```

## §3 No SQL / schema changes.

## §4 Integration

### §4.0 Circular-dep — Architect decision: EXTRACT (not re-export, not duplicate)

Cycle if guard imports from chat.ts: `chat → send-guard-chain → persona-guard → chat`. ESM tolerates cycles but top-level `const IDENTITY_DEFLECTIONS` is unsafe under partial-init. Decision: extract const to `src/utils/identity-deflections.ts`; `chat.ts:329` becomes a re-export (preserving `test/chat.test.ts:2` public import); guard imports from utils directly. No cycle, no drift. Same single pool — extension (9 items) lives in the new file per §2.

### §4.1 chat.ts `IDENTITY_DEFLECTIONS` (line 329)

Replace literal with `export { IDENTITY_DEFLECTIONS } from '../utils/identity-deflections.js';`

### §4.2 chat.ts `IDENTITY_PROBE` (line 306-307) — append 4 alternation groups

```ts
export const IDENTITY_PROBE =
  /(你\s*是\s*(不是\s*)?(一个?\s*)?(bot|ai|机器人|真人)|你\s*是\s*人\s*吗|是\s*(不是\s*)?(bot|ai|机器人)\s*吧|(bot|ai)\s*吧|真人吗|这\s*不\s*是\s*(bot|ai|机器人)|are\s+you\s+(an?\s+)?(bot|ai|human)|你(?:多大|几岁|多少岁)|你年龄|你(?:是)?男(?:的|生|性)?(?:还是)?女|你是男是女|你男的女的|你是不是[男女]|你多高|你多重|你身高|你体重|你住(?:在)?哪|你真名|你本名|你叫啥)/i;
```

### §4.3 `buildSendGuards()` (send-guard-chain.ts:56-58)

```ts
import { personaFabricationGuard } from './persona-fabrication-guard.js';
export function buildSendGuards(): SendGuard[] {
  return [stickerLeakGuard, harassmentHardGate, personaFabricationGuard];
}
```

### §4.4 `BLOCKED_SELF_ATTR_PATTERNS` (from DESIGN-NOTE §Regex table)

```ts
export const BLOCKED_SELF_ATTR_PATTERNS: readonly RegExp[] = [
  /我\s*(?:是\s*)?[女男](?:的|生|性)(?!朋友|厕所|宿舍|生组|生气|生)/,
  /我\s*\d{1,3}\s*岁/,
  /我\s*(?:身高|体重)\s*\d/,
  /我\s*住\s*(?:在\s*)?(?!这|那)[\u4e00-\u9fa5]{2,6}(?:市|区|县|省|里|附近)?/,
  /自己\s*(?:是\s*)?[女男](?:的|生|性)/,
];
const STANDALONE_SHORT_RE =
  /^[^，。！？,.!?\w]*[女男]\s*的?\s*\d{1,3}\s*岁?[^，。！？,.!?\w]*$/u;
```

`hasSelfPersonaFabrication(text)`:
1. `s = stripCqReply(text)`; empty → `false`.
2. For each pattern in `BLOCKED_SELF_ATTR_PATTERNS`: `re.test(s)` → return `true`.
3. If `s.length <= 15 && STANDALONE_SHORT_RE.test(s)` → return `true`.
4. Return `false`.

### §4.5 `personaFabricationGuard`

```ts
export const personaFabricationGuard: SendGuard = (text, ctx) => {
  if (!hasSelfPersonaFabrication(text)) return { passed: true, text };
  logger.info({ groupId: ctx.groupId }, 'persona-fabrication-blocked');
  return { passed: false, reason: 'persona-fabricated', replacement: 'deflection' };
};
```
Quote isolation: guard body must NOT reference `ctx.triggerMessage` / any `recentMessages` field.

### §4.6 `chat-result.ts` (line 33)

Extend silent union:
```ts
reasonCode: 'guard'|'scope'|'confabulation'|'timing'|'bot-triggered'|'downrated'|'dampener'|'self-echo'|'sticker-leak-stripped'|'hard-gate-blocked'|'persona-fabricated'
```
No fallback union change. Mapping guard→ChatResult handled at existing `chat.ts` send-site (same pattern as PR2 harassment's `neutral-ack` deferred mapping — guard emits `replacement:'deflection'`; the send-site mapper consumes it and calls `pickPersonaDeflection()` when rendering the silent→deflection branch per Decision B).

### §4.7 `scripts/eval/violation-tags.ts`

Union + `ALL_VIOLATION_TAGS` append:
```ts
| 'persona-fabrication-blocked'
| 'persona-fabricated-in-output'
```
`ProjectedRow` append:
```ts
personaFabricationFired: boolean;
personaFabricatedInOutput: boolean;
```
`computeViolationTags` append (after `harassment-escalation`):
```ts
if (row.resultKind === 'silent' && row.personaFabricationFired) tags.push('persona-fabrication-blocked');
if (outputted && row.personaFabricatedInOutput) tags.push('persona-fabricated-in-output');
```
`DENOMINATOR_RULES`:
```ts
'persona-fabrication-blocked':  () => true,
'persona-fabricated-in-output': (_g, r) => isOutputted(r.resultKind),
```

### §4.8 `replay-runner-core.ts:267` + `replay-summary.ts:133`

Both — in `ProjectedRow` literal after `harassmentEscalationFired`:
```ts
personaFabricationFired: reasonCode === 'persona-fabricated',
personaFabricatedInOutput:
  (result.kind === 'reply' || result.kind === 'fallback')
    ? hasSelfPersonaFabrication(result.text)
    : false,
```
(summary.ts uses `r.replyText`; import `hasSelfPersonaFabrication` from `../../src/utils/persona-fabrication-guard.js`)

## §5 Test contract

### `persona-fabrication-guard.test.ts` — 5 must-fire, 10 must-NOT

Must-fire: `"我22岁"`, `"我是女的"`, `"我身高170"`, `"女的22岁"`, `"男的"` (last 2 standalone len≤15).

Must-NOT: `"她22岁"`, `"他是男的"`, `"拉普兰德身高170"`, `"去女生厕所"`, `"进男生宿舍"`, `"自己猜"`, `"不告诉你"`, `"问这个干嘛"`, `"我不知道"`, `"我忘了"`, `"她说她22岁了"`, `""`, `"   "`, `"我22号去看演出"`.

### `send-guard-chain.persona.test.ts` — short-circuit (spy)

- sticker fail (`"<sticker:5>"`) → reason `sticker-leak-stripped`; persona spy NOT called.
- sticker pass + harassment fail (`"你傻逼"`) → reason `hard-gate-blocked`; persona spy NOT called.
- sticker pass + harassment pass + persona fail (`"我22岁"`) → reason `persona-fabricated`, `replacement:'deflection'`.
- All pass (`"今天天气不错"`) → `passed:true`, unchanged text.

### `violation-tags-persona.test.ts`

- `{resultKind:'silent',personaFabricationFired:true}` → tag present.
- `{resultKind:'reply',personaFabricatedInOutput:true}` → tag present.
- `DENOMINATOR_RULES['persona-fabrication-blocked']` → `true` any row.
- `DENOMINATOR_RULES['persona-fabricated-in-output']` → `false` silent, `true` reply/sticker/fallback.

### `chat-identity-probe-extended.test.ts`

True: `"你几岁"`, `"你是男是女"`, `"你多高"`, `"你住在哪"`, `"你真名"`, `"你多大"`, `"你男的女的"`, `"你年龄"`, `"你叫啥"`.
False: `"她几岁"`, `"拉普兰德身高多少"`, `"我住在哪里来着"`.

## §6 Acceptance + Reviewer spot-checks

### Dev handoff paste (verbatim):

- `npx tsc -p . --noEmit` → 0 errors
- `npx tsc -p tsconfig.scripts.json --noEmit` → 0 errors
- `npx vitest run` → baseline 3944 green + new tests green
- Replay smoke: runner does not panic; `personaFabricationFired` projected
- `grep -c "personaFabricationGuard" src/utils/send-guard-chain.ts` → 2
- Chain proof: `grep "return \[stickerLeakGuard" …` → ends `, personaFabricationGuard]`
- `grep -c "IDENTITY_DEFLECTIONS" src/modules/chat.ts` → 1 (re-export only)

### Reviewer spot-checks (paste into Reviewer task):

1. Chain shape: `buildSendGuards()` returns `[stickerLeakGuard, harassmentHardGate, personaFabricationGuard]` exact order.
2. Chain short-circuit: `send-guard-chain.persona.test.ts` spy-asserts guards after failure are unused.
3. Tag 1:1: `personaFabricationFired` written in both `replay-runner-core.ts` + `replay-summary.ts`; `personaFabricatedInOutput` uses `hasSelfPersonaFabrication` at both sites.
4. Self-attribution: `"她22岁"` does NOT fire; `"我22岁"` fires.
5. Quote isolation: `grep -L "triggerMessage\|recentMessages" src/utils/persona-fabrication-guard.ts` — no matches.
6. No cycle: `grep "from '../modules/chat" src/utils/persona-fabrication-guard.ts` → no matches (const comes from `identity-deflections.js`).
7. Compound lookahead: `"女生厕所"`, `"男生宿舍"`, `"女朋友"` do NOT fire.

## §7 Constraints

Branch `fix/identity-persona-guard` in worktree. No Co-Authored-By. Conventional commit `fix:`/`feat:`. Dev writes code directly (no bare Agent), does NOT mark task #4 complete (Reviewer + merge gate it).
