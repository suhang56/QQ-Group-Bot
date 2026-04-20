# R2.5 — Low-info dampener / self-amplification guard / scope-addressee guard

## Why

Post-R2a live observations (screenshots 2026-04-20) show 3 residual issues after direct @s bypass timing gate:

1. **Low-info loop** — `@bot 你好 → 烦死了 → @bot 不要烦 → 烦什么啊 → …` bot overreplies to repeated low-content triggers
2. **Self-amplification** — bot's own emotive outputs (烦/累/气…) feed back into next-turn recent-history → LLM echoes the mood again
3. **Small-scene plural-you** — `@NJ kaan 你好` (2 speakers, bot not addressee) → bot inserts `烦你们` outsider voice

Master baseline (post-R2a): direct-at-silenced-by-timing 0/48, silence_defer_compliance 100%, aggregate 40/48.
These 3 issues are not covered by existing replay tags; 4 new R6.4 violation tags needed.

North-star check: groupmate doesn't flip out when repeatedly poked / doesn't self-excite / doesn't say 你们 to 2 people.

## Scope IN

### SF1 — Low-info direct dampener
- Per-(groupId, userId) in-memory Map tracking `lastDirectReplyAtSec`
- Trigger: direct @bot OR reply-to-bot with **no** known-fact-term AND **no** real question AND bot already replied to same user within 60s
- Output: silent OR ≤3-char neutral ack (好哦 / 嗯 / 哦)
- Exceptions (never dampen): fact-term present / real question / admin / moderation / command routing

### SF2 — Self-amplification guard
- Inspect bot's own last N=3 outputs within 5-min window (per groupId) for negative emotive stems: 烦/气/累/崩/麻/无语
- If ≥2 of 3 contain such stems AND current LLM candidate also contains one → reject/rewrite candidate
- Apply as post-LLM sentinel (same layer as existing `isAddresseeScopeViolation`)
- NOT applied to: deflection-engine outputs, explicit user echoes (user quote-repeating bot's word)

### SF3 — Scope/addressee guard (extend existing)
- `distinctNonBotSpeakers < 3` AND bot is not direct addressee (no CQ:at-bot, no reply-to-bot) → forbid 你们/大家 in output (already partially in `isAddresseeScopeViolation` — wire the per-call distinctSpeakers more consistently to the post-LLM sentinel)
- `@target != bot` AND no fact term AND no bot-status keyword → silent (bot not relevant to this exchange)
- Existing `isAddresseeScopeViolation(text, dSpeakers)` already in chat.ts:2658 — verify coverage and fill gaps

### New R6.4 violation tags (replay harness)
- `repeated-low-info-direct-overreply`
- `self-amplified-annoyance`
- `group-address-in-small-scene`
- `bot-not-addressee-replied`

## Scope OUT

- Do NOT touch R2a `_classifyPath` or `isDirect` signals (working)
- Do NOT modify on-demand-lookup validator (`isValidStructuredTerm`) — emotive-fix already handles that
- Do NOT touch deflection-engine (separate ticket)
- Do NOT add persistent DB cooldown — in-memory Map only (R2c precedent)
- R2c still owns non-direct per-group `lastBotReplyAtSec`; R2.5 adds per-(group,user) for direct path only
- Do NOT touch R2b defer recheck / R4-lite strategy / R5 prompt assembler

## Acceptance criteria

- [ ] SF1: 5 back-to-back @bot from same user within 60s → 1 full reply + ≥4 silent/neutral-ack
- [ ] SF1: same user @bot with fact term within 60s → full answer (fact exception fires)
- [ ] SF1: first @ from user (no prior reply) → full reply regardless of content
- [ ] SF2: bot history has `烦` in 2 of last 3 outputs → next `烦`-containing candidate rejected/rewritten
- [ ] SF2: user quotes bot's own `烦死了` back → NOT treated as self-amplification (echo exemption)
- [ ] SF3: 2-speaker scene + bot not addressee + `你们` in LLM output → filtered to silent or rewrite
- [ ] SF3: @third-party + no bot-at + no fact term → silent (bot-not-addressee path)
- [ ] 4 new R6.4 violation tags have predicate functions + vitest unit tests
- [ ] Replay: `direct-at-silenced-by-timing` still 0/48; `silence_defer_compliance` ≥ 95%
- [ ] tsc clean; full vitest suite passes

## Edge cases to test

1. First @bot in session (no cooldown entry) → full reply (no false dampening)
2. Direct @bot with `ykn是谁` inside 60s → fact exception, full answer
3. Admin `/kick` command within cooldown window → hard-bypass, no dampener
4. Bot history: `笑死` appears in last 3 outputs → NOT self-amplification (ALLOWLIST from emotive-fix)
5. Large group (20+ speakers) + `@NJ kaan` + bot not addressee → SF3 silent path
6. SF2 regen loop: first regen also contains stem → second regen or silent drop (max 1 regen)
7. Same user 3rd @bot with new content tokens differing from last — Designer to decide: dampen or pass?
8. Emotive stem in user message (not bot output) → SF2 NOT triggered (only bot's own recent history)

## Open questions for Designer

1. SF1 "low-info" definition: content.length ≤ threshold OR token overlap with prior trigger OR both? What threshold?
2. SF1 same-user 3rd @bot with new topic (distinct tokens) — dampen or let through? User intent signal?
3. SF2: post-LLM sentinel vs prompt-layer hint vs both? Prompt-layer risks token waste if sentinel catches it anyway.
4. SF3: reuse existing `distinctNonBotSpeakersImmediate` from chat.ts:63 for bot-not-addressee path, or compute fresh in router pre-chat?
5. SF2 stem list: reuse `EMOTIVE_STEMS` extracted from `is-emotive-phrase` predicate, or define independently? Risk of divergence if defined separately.
