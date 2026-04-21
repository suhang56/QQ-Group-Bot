# Feature: harassment-response-ceiling (PR2)

## Why

Log `bot-2026-04-20.log:4112/4204/4432/5589` — phrase-miner cataloged `再@我你试试` 5+ times
as jargon, confirming bot is the producer (bot replies pass phrase-miner). Screenshots show
`怡你妈 / 你有病吧` in bot output. Bot escalating into profanity/threats when provoked = CRITICAL
safety failure. Plan §PR2 + struggle-log 2026-04-21 §③.

## Scope IN

1. NEW `src/utils/output-hard-gate.ts` — deterministic, no-LLM, no-regen BLOCKED_TEMPLATES filter
2. Append `harassmentHardGate: SendGuard` to `buildSendGuards()` in `send-guard-chain.ts` (PR2 is first appender after PR1's `stickerLeakGuard`)
3. Input scope: **bot outgoing text only** — strip CQ:reply quote blocks before matching
4. Replacement strategy: `silent` preferred; `neutral-ack` fallback from existing `NEUTRAL_ACK_POOL`
5. Replay telemetry: tag `hard-gate-blocked` (gate fires) and `harassment-escalation` (blocked term reached send path)
6. Tests: must-fire set + ≥7 must-NOT-fire scenarios (unit + integration with mocked chain)

## Scope OUT

- Sticker leak guard — PR1 (merged)
- Persona fabrication guard — PR4
- `烦死了 / 想屁吃呢 / 爱谁记谁记` (annoyed tone family) — belongs to R2.5.1 TEMPLATE_FAMILY, not hard gate
- Curse deflection pool contents — not modified; gate only intercepts final outgoing text
- User messages or quoted content containing blocked terms — chain sees bot output only

## Acceptance

- `tsc --noEmit` + `tsc -p tsconfig.scripts.json` clean
- `vitest` all pass: must-fire + ≥7 must-NOT-fire; no regression on R2a replay tags
- Replay: `hard-gate-blocked` count > 0 (gate is reachable); `harassment-escalation` count = 0 (bot produces zero blocked output)
- `direct-at-silenced-by-timing` 0/48 unchanged; `silence_defer_compliance` ≥ 95%
- Reviewer spot-checks:
  a) `harassmentHardGate` registered in `buildSendGuards()` return array, after `stickerLeakGuard`
  b) Gate input is bot outgoing text with CQ:reply blocks stripped — grep to confirm no history/user-input path feeds gate
  c) `hard-gate-blocked` tag written inside `harassmentHardGate` function, not in chain runner

## Must-NOT-fire (≥7 enumerated)

1. **Annoyed tone** — `烦死了 / 想屁吃呢 / 爱谁记谁记` must pass; these are R2.5.1 territory
2. **傲娇 deflection** — `哼 / 切 / 呵 / 啧 / 又来了 / 随便你` must pass; tsundere persona preserved
3. **User input containing blocked term** — user sends `怡你妈`; chain only sees bot's reply text, not user message
4. **CQ:reply quote block** — bot quotes user's `草你妈` in a reply block; gate must strip quote before match, pass bot's own clean response text
5. **Curse deflection pool normal output** — pool returns `烦` (single char), `有完没完`, `你烦不烦` — none match BLOCKED_TEMPLATES
6. **Word boundary: `滚石 / 滚进来`** — `滚` appears in non-imperative compound; regex must not fire on substring
7. **Fandom term collision** — if `尼玛` appears as part of a fandom nickname/term in lore data, ALLOWLIST carve-out must prevent false positive (Designer to verify via lore grep)
8. **Empty / media-only text** — guard receives empty string after sticker strip; must return `passed: true` with empty text, not block

## Open Questions for Designer

1. **Word boundary strategy** — does BLOCKED_TEMPLATES need `\b`-equivalent for CJK (`滚蛋` vs `滚石`)? Chinese has no `\b`; consider prefix/suffix exclusion list vs length check.
2. **Chain position confirmed** — PR2 appends after `stickerLeakGuard` (index 1); does any future guard need to run *before* harassment gate? Flag if ordering assumption changes.
3. **Replacement selection logic** — always `silent`, or `neutral-ack` when gate fires on mild escalation (e.g. `闭嘴`) vs severe (`怡你妈`)? Define threshold or default-to-silent?
4. **ALLOWLIST fandom grep** — Designer should `grep -r` `data/lore/` for any fandom terms overlapping `尼玛 / 滚 / 有病` before finalizing BLOCKED_TEMPLATES to avoid false positives.
