# Feature: PR4 `fix/identity-persona-guard` — persona fabrication guard

## Why

`struggle-log.md §② persona fabrication`: trigger `你是男的女的老的少的？` → `bot-2026-04-21.log:2659`
bot 产 `女的22岁`(phrase-miner `:3104` 缓存),被存入 meme_graph → 后续 prompt 可回放同一错误答案。
Bot 凭空声明硬属性(性别/年龄)= 数据完整性违规 + 自激 memory 污染。
`curried-wondering-rocket.md §PR4`:第 3 guard,chain 顺序 `[sticker, harassment, persona]`。

## Scope IN

1. NEW `src/utils/persona-fabrication-guard.ts` — `personaFabricationGuard: SendGuard`
   - Deterministic regex patterns for self-attributed hard facts
   - Returns `{ passed: false, reason: 'persona-fabricated', replacement: 'deflection' }`
2. MODIFY `src/utils/send-guard-chain.ts` — `buildSendGuards()` returns `[stickerLeakGuard, harassmentHardGate, personaFabricationGuard]`
3. MODIFY `src/modules/chat.ts:305` — expand `IDENTITY_PROBE` regex: add age / gender / height / weight / address / real-name probes (bot-self only)
4. MODIFY `src/utils/chat-result.ts` — extend `fallback` reasonCode union with `'persona-fabricated'`
5. NEW `src/utils/violation-tags.ts` (or MODIFY if exists) — add tags `personaFabricationBlocked` / `personaFabricatedInOutput`
6. MODIFY `src/modules/chat.ts` IDENTITY_DEFLECTIONS — append `['问这个干嘛', '别研究这个', '自己猜', '不告诉你']`
7. NEW tests `test/utils/persona-fabrication-guard.test.ts` — must-fire + must-NOT-fire (≥7 each)

## Scope OUT

- 他人 fact query (`西瓜几岁 / 拉普兰德是男是女 / 她22岁`) — 属 R3 fact-retrieval, not persona guard
- User message content (guard only sees bot outgoing text — chain contract from PR1/PR2)
- Quote / CQ-reply block body — guard sees post-strip chain text only
- Tsundere deflections (`自己猜 / 不告诉你 / 问这个干嘛 / 我不知道 / 忘了`) — valid honest-gap, pass through
- PR1 sticker-leak / PR2 harassment / PR3 phrase-miner-filter scope

## Must-NOT-fire (≥7 enumerated)

1. `她是女的 / 拉普兰德22岁 / 他身高175` — third-person; regex must require self-attribution anchor (`我/自己`)
2. `西瓜几岁？` in user trigger message — guard input is bot outgoing only; user message never enters chain
3. Bot output `自己猜 / 不告诉你 / 问这个干嘛 / 别研究这个` — explicit tsundere deflection; pass
4. Bot output `我不知道 / 忘了 / 不记得了` — honest-gap; no hard attribute claimed; pass
5. `女生厕所 / 男生宿舍 / 男生组` — compound words; regex must use negative-lookahead `(?!朋友|厕所|宿舍|生组)`
6. `我22` embedded in longer non-persona sentence (e.g. `我22号去看演出`) — guard must not false-positive on date/count context; Designer to spec length or context guard
7. Bot quoting user's own sentence that contains hard-attr — guard sees stripped text; CQ-reply block already excluded
8. Bot output `大概吧 / 说不定 / 谁知道呢` — vague/evasive non-claim; pass

## Acceptance Criteria

- [ ] `tsc` clean (worktree + main tsconfig)
- [ ] `vitest` full suite: no regress vs baseline (3944 passing); new guard tests all green
- [ ] `buildSendGuards()` returns exactly `[stickerLeakGuard, harassmentHardGate, personaFabricationGuard]`
- [ ] Chain short-circuit correct: sticker fail → harassment + persona NOT fired
- [ ] Replay trigger `你是男的女的老的少的？` → tag `personaFabricationBlocked` fires, reply is deflection not `女的22岁`
- [ ] Tag `personaFabricatedInOutput` = 0 on replay of known probe set
- [ ] PR1/PR2 tags (`sticker-token-leak`, `hard-gate-blocked`) remain stable — no regress

## Edge Cases to Test

- Short reply `女的22岁` (≤15 chars, no `我` anchor) — should fire if Designer opts in standalone-short-reply detection
- `我` anchor with non-numeric evasion `我是…` trailing ellipsis — should NOT fire (no hard value)
- Multi-attribute claim `我是女的,22岁,住大阪` — single guard call fires once, chain stops
- Empty string / whitespace-only text — must not panic, pass
- CJK unbroken token `我女的22岁朋友` — compound context; must not fire (not self-attribute claim)

## Open Questions for Designer

1. **Self-attribution anchor**: require explicit `我/自己` OR also block standalone short-reply (`女的22岁`, len ≤15) as implicit self-claim?
2. **`IDENTITY_PROBE` exact form**: which new trigger phrases to add; Architect to grep `chat.ts:305` for current regex before speccing
3. **Replacement strategy**: `silent` (no reply) vs `deflection` (draw from `IDENTITY_DEFLECTIONS` pool)?
4. **`我住[地点]` pattern scope**: address-claim regex may be too broad (matches `我住在这附近很久了`); Designer to decide threshold or exclude
5. **`ProjectedRow` shape**: does `personaFabricationBlocked` / `personaFabricatedInOutput` require new columns, or append to existing violation-tags enum?
