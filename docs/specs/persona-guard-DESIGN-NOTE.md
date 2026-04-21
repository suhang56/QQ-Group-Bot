# DESIGN-NOTE: PR4 persona-fabrication-guard

## Surface: SendGuard module

### Resolved Q1 — Self-attribution anchor policy
- Require explicit `我` OR `自己` anchor **OR** standalone short-reply (full reply len ≤ 15, no embedding sentence)
- Standalone short-reply detection: `^[^\u4e00-\u9fa5a-zA-Z]*[女男]\s*的?\s*\d{1,3}\s*岁?[^\u4e00-\u9fa5a-zA-Z]*$` (captures `女的22岁` / `22 女` without `我`)
- Must-NOT lookahead: `(?!朋友|厕所|宿舍|生组|生气|生)` on `男生` / `女生` compounds

### Resolved Q2 — `IDENTITY_PROBE` exact extension (append to existing regex, OR form)
```
你(?:多大|几岁|多少岁)|你年龄
你(?:是)?男(?:的|生|性)?(?:还是)?女|你是男是女|你男的女的|你是不是女|你是不是男
你多高|你多重|你身高|你体重
你住(?:在)?哪|你真名|你本名|你叫啥
```

### Resolved Q3 — Replacement: **Choice B (deflection)**
- Guard selects from extended `IDENTITY_DEFLECTIONS` internally — no `SendGuardCtx` extension needed
- Guard imports `IDENTITY_DEFLECTIONS` from `chat.ts` (re-exported) and picks via `Math.floor(Math.random() * pool.length)`
- Returns `{ passed: false, reason: 'persona-fabricated', replacement: 'deflection' }`

### Resolved Q4 — No ALLOWLIST
- No legitimate scene for bot self-claiming hard attrs; pure blacklist only

### Resolved Q5 — `ProjectedRow` flags
- `personaFabricationFired: boolean` — guard fired → silent
- `personaFabricatedInOutput: boolean` — bot outputted self-attr despite guard (target = 0)

## Surface: Regex pattern table

| Pattern | Fires on | Condition |
|---|---|---|
| `/\b我\s*(?:是\s*)?[女男](?:的|生|性)\b(?!(?:朋友|厕所|宿舍|生组))/` | `我是女的` / `我男生` | explicit anchor |
| `/\b我\s*\d{1,3}\s*岁\b/` | `我22岁` / `我 22 岁` | explicit anchor + age |
| `/\b我\s*(?:身高|体重)\s*\d/` | `我身高170` / `我体重55` | explicit anchor + metric |
| `/\b我\s*住\s*(?:在\s*)?[\u4e00-\u9fa5]{2,6}(?:市|区|县|省|里|附近)?\b/` | `我住大阪` | anchor + place (≥2 CJK, no `这附近` false-pos) |
| `/^[^，。！？,.!?\w]*[女男]\s*的?\s*\d{1,3}\s*岁?[^，。！？,.!?\w]*$/u` | standalone `女的22岁` | full-reply ≤15 chars, no anchor |
| `/\b自己\s*(?:是\s*)?[女男](?:的|生|性)\b/` | `我自己是女的` | `自己` anchor |

## Surface: `chat-result.ts` — reasonCode extension
- `fallback` union: append `'persona-fabricated'` (maps to deflection reply kind)

## Surface: `violation-tags.ts` — ViolationTag extension
```typescript
| 'persona-fabrication-blocked'   // guard fired → silent
| 'persona-fabricated-in-output'  // bot sent self-attr (target=0)
```
- `ProjectedRow` adds: `personaFabricationFired: boolean; personaFabricatedInOutput: boolean`
- DENOMINATOR: both `() => true` (final-send filter, any outcome qualifies)

## Surface: Chain wiring
- `buildSendGuards()` returns `[stickerLeakGuard, harassmentHardGate, personaFabricationGuard]`
- Chain position 3: sticker+harassment short-circuit before persona check (correct — defer expensive probe-match)

## Surface: `IDENTITY_DEFLECTIONS` extended pool
```typescript
['啊？', '什么', '？？', '?', '啧', '问这个干嘛', '别研究这个', '自己猜', '不告诉你']
```

## Conflicts with existing convention
- NONE — follows PR1/PR2 pattern exactly (pure-predicate module + guard export + violation-tags extension)
- `我22号去` false-positive risk: `我\s*\d{1,3}\s*岁` requires `岁` suffix — date `22号` won't match

## Open questions for Architect
- Re-export `IDENTITY_DEFLECTIONS` from `chat.ts` or duplicate in guard module? Suggest re-export to avoid drift.
- `我住在这附近很久了` — place regex requires ≥2 CJK + no `这` prefix; Architect to verify negative lookahead form.
