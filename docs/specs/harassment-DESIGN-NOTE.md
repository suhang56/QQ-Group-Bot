# DESIGN-NOTE: harassment-response-ceiling (PR2)

## Surface: SendGuard module + chain

### BLOCKED_TEMPLATES (exact-phrase regex, no wildcards)

| Pattern | Matches | Must-NOT-fire |
|---|---|---|
| `怡你妈` | literal | — |
| `你他妈` | literal | — |
| `操你妈\|草你妈\|炒你妈` | all three variants | 炒 is group lore deflection — **ALLOWLIST: `炒你妈` when bot is responding to `炒/炒我` provocation** (see §ALLOWLIST) |
| `去死\|去你妈的死` | imperative | — |
| `有病吧(?!.*\?)` negative-lookahead for deflection? | **EXCLUDED** — `有病吧` is normal deflection pool output per PLAN §must-NOT-fire row 5 |
| `滚(?:蛋\|开)` | `滚蛋` / `滚开` only | `滚石` / `滚进来` / `滚` alone safe |
| `再@我你试试\|再@我试试` | threat pattern from logs | — |
| `闭嘴\|给我闭嘴` | imperative silencing | — |
| `sb\b\|傻逼` | insult | `逼` alone not blocked |
| `脑子有问题` | insult | — |

### ALLOWLIST (fandom grep results)

Lore file `958751334.md` findings:
- `炒你妈` appears in §黑话 as the **correct bot deflection response** to `炒/炒我` provocations — must NOT be blocked when it is the bot's own deflection
- `妈咪/宝宝` — high-frequency affectionate group terms, zero blocking needed
- `你他妈` appears in lore as an example of authentic group speech (not fandom term) — **block confirmed**
- `尼玛` — NOT found in lore; block confirmed
- `滚蛋` appears in lore §黑话 as correct bot response to `炒我` — **ALLOWLIST: `滚蛋` as single-token response only** (len ≤ 4 and no surrounding escalation)
- `逼` — appears in `sb`/`傻逼` context only; standalone `逼` in compounds safe → block only full `傻逼`

**ALLOWLIST implementation**: pass-through if `text.trim() === '滚蛋'` OR `text.trim() === '炒你妈'` (single-token deflection responses); all other occurrences blocked normally.

### Gate shape (new file: `src/utils/output-hard-gate.ts`)

```ts
export const harassmentHardGate: SendGuard = (text, _ctx) => { ... }
// 1. stripCqReply(text) — remove [CQ:reply,...] prefix
// 2. if stripped === '' → { passed: true, text }
// 3. check ALLOWLIST single-token pass-throughs
// 4. test BLOCKED_TEMPLATES regexes
// 5. log pino event 'hard-gate-blocked' with { term, groupId: _ctx.groupId }
// 6. return { passed: false, reason: 'hard-gate-blocked', replacement: 'neutral-ack' }
```

### Chain position

`buildSendGuards()` returns `[stickerLeakGuard, harassmentHardGate]` — sticker guard runs first (protocol), harassment gate second (semantic). No future PR inserts between these two.

### Replacement strategy

**Default: `neutral-ack`** (draw from `NEUTRAL_ACK_POOL` in `direct-cooldown.ts`). Rationale: a groupmate being insulted says `? / 啊 / 啧` not nothing — `silent` is unnatural for direct provocation. `silent` reserved for escalation (v2 scope only).

### New violation tag

Add `'harassment-escalation'` to `ViolationTag` union — fires in replay when `hard-gate-blocked` count > 0. Target: 0 in production replay.

### Naming decisions

- File: `src/utils/output-hard-gate.ts` (consistent with `sticker-token-output-guard.ts` pattern)
- Guard export: `harassmentHardGate` (camelCase, matches `stickerLeakGuard`)
- Pino event: `hard-gate-blocked` (kebab, matches `sticker-leak-stripped` precedent)
- Replay tag: `harassment-escalation` (kebab, matches existing tag style)

### SendGuardCtx extension

**Not needed** — current `{ groupId, triggerMessage, isDirect, resultKind }` sufficient for logging groupId.

### Must-NOT-fire complete list (8 from PLAN + 2 from fandom grep)

1. `烦死了 / 想屁吃呢 / 爱谁记谁记` — R2.5.1 annoyed-tone family
2. `哼 / 切 / 呵 / 啧 / 又来了 / 随便你` — 傲娇 deflection pool
3. User input containing blocked term — gate sees bot output only
4. CQ:reply quote block — strip before match
5. Curse deflection pool: `烦 / 有完没完 / 你烦不烦` — none match templates
6. `滚石 / 滚进来` — regex `滚(?:蛋|开)` won't match
7. Fandom collision: `炒你妈` as single-token deflection → ALLOWLIST pass-through
8. Empty / media-only text — empty string after strip → `passed: true`
9. **Fandom collision: `滚蛋` as single-token deflection** → ALLOWLIST pass-through
10. **`妈咪 / 宝宝`** — not in BLOCKED_TEMPLATES; zero risk

### Conflicts with existing convention

- NONE
