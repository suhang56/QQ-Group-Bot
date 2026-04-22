# Feature: R2.5.1 scope-guard unified

## Why

PR1–4 merged (977cec9/1e7feab/ed8f798/49c4ae8). Send-guard-chain covers sticker-leak/harassment/
persona-fabrication. Post-deploy live (2026-04-21) exposed scope-claim failure without plural-you:
bot produced `又来了` in a relay chain (mention=0/replyToBot=0/twoUser=-0.3, engagement 0.55).
Bot read group热闹 as "大家在冲我". Plan ref: `curried-wondering-rocket.md` § PR5 R2.5.1.
Struggle-log: 2026-04-21 SF3 精修.

**North star: "别把群聊热闹误判成群聊在冲 bot"**

---

## Scope IN (5 items)

### Item 1 — Scope guard: bot-not-addressee default-silent
Raise engagement threshold for non-direct/non-reply-to-bot scenes (≈0.506 → ≈0.7, Designer pins).
Bypass only for: CQ:at-bot / reply-to-bot / fact-hit / lore-hit / fandom keyword.

### Item 2 — Scope-claim guard (Group A + Group B, independent regex + trigger)

**Group A — plural-you scope-claim** (refactor of existing SPECTATOR_PATTERNS):
- Regex family: `你们 / 你俩 / 大家 / 诸位 / 你们几个 / 你们别X / 你们都X`
- Trigger: `speakerCount < 3` AND `!directAddressee`
- Narrow escape: ≥2 distinct recent speakers each direct-poke bot (CQ:at or reply-to-bot) → allow

**Group B — self-centered scope-claim** (new, post-deploy observation):
- Regex: full-line anchored `又来了 / 又开始了 / 又来搞我 / 又在搞我 / 还来 / 又一次 / 有完没完`
  (trailing optional punct; embedded occurrences NOT matched)
- Trigger: **speakerCount-agnostic** — `!isAtMention && !isReplyToBot && !prevBotTurnAddressed`
  (`prevBotTurnAddressed` = last 2 msgs before bot's prev turn contained CQ:at-bot OR CQ:reply-to-bot)
- Single-fire: check addressee immediately; do NOT require count ≥ 2

Both groups in `src/utils/scope-claim-guard.ts`; two independent `if` blocks, no short-circuit.

### Item 3 — ANNOYED_TEMPLATE_FAMILY cooldown
Family: `烦死了 / 想屁吃呢 / 爱谁记谁记 / 你们别烦我 / 又来了 / 你烦不烦 / 你复读机 / 爱谁记谁 / 想屁吃`
Trigger: recent 3 bot outputs contain family member ≥ 2 AND current candidate also matches
→ regen-once → silent if still matches.
Boundary: Group B checks addressee (single-fire); TEMPLATE_FAMILY checks consecutive count.
Both guards independent — neither short-circuits the other.

### Item 4 — Non-engagement bias (threshold raise)
Low-info scenes (no @/reply/fact/lore/fandom) → silent. Threshold value: Designer decision.

### Item 5 — Purge social-phrase learned_facts
Clear `learned_facts` where `topic LIKE 'opus-classified:slang:%'` and canonical is social-phrase
(`我喜欢你 / 宝宝 / 晚安 / 贴贴 / 晚上好` etc). New predicate `isSocialPhrase` (≠ `isEmotivePhrase`).
CLI: dry-run default, `--apply`, `--db-path` required, no DELETE (mark rejected).
ALLOWLIST: fandom terms in `data/lore` are immune.

---

## Scope OUT

1. **R3.1 topic-continuity** — pronoun coref / reference tracking — own PR, post this one
2. **Identity-confusion fallback quality** — PR 7, not this PR
3. **New act/ChatResult meta types** — scope too large; predicate-based post-check only
4. **Broad noun mining / NER** — prohibited even for topic continuity prep
5. **Cat 8 (fact-pipeline debug)** — independent PR, not tone/傲娇 family

---

## Must-NOT-fire (≥10 concrete scenes)

1. **Group A + multi-user围攻**: speakerCount ≥ 3 AND 2+ distinct users each CQ:at-bot → escape applies
2. **Group A keyword embedded in long sentence**: `你们好多人啊讨论音乐呢` — no anchor match → pass
3. **Group B: isAtMention/isReplyToBot = true**: `又来了` is legitimate 被逗 response → pass
4. **Group B: prevBotTurnAddressed = true**: last 2 msgs before bot's prev turn had CQ:at/reply-to-bot
   → standalone `又来了` passes first time; 2nd consecutive falls to TEMPLATE_FAMILY, not Group B
5. **Group B: long-sentence embed**: `又开始了在讨论音乐` — full-line anchor required → pass
6. **Group B: user message input**: guard checks bot outgoing text only → user input never enters
7. **Group B: empty / whitespace**: regex no-match → pass
8. **Group B: 傲娇首次 (addressed)**: first `又来了` WITH addressee + no prior family hits → pass
9. **TEMPLATE_FAMILY: precursor single-use**: `哼/切/呵/啧` once = tsundere, not escalation → pass
10. **TEMPLATE_FAMILY: count = 1**: family member appears once in 3-turn window (not ≥ 2) → pass
11. **Purge: fandom allowlist**: `data/lore` terms immune even if surface matches social-phrase

---

## Acceptance KPIs (baseline 49c4ae8, all violation tags direction ↓)

- `bot-not-addressee-replied` ↓ significant
- `group-address-in-small-scene` ↓ ≥80%
- `self-centered-scope-claim` (new) ↓ — `又来了/又开始了` w/o addressee
- `annoyed-template-consecutive` ↓ ≥70%
- `self-amplified-annoyance` ↓
- `repeated-low-info-direct-overreply` ↓

Non-regress: `direct-at-silenced-by-timing`=0 / `silence_defer_compliance`≥95% / `sticker-token-leak`=0 /
`hard-gate-blocked` stable / `persona-fabrication`=0.
`mockClaudeCalls` may decrease (more silent paths) — expected, not regression.

---

## Open Questions for Designer

1. **Group B regex trailing punct**: `[。.!?~～]*` optional per plan — confirm or tighten?
2. **prevBotTurnAddressed window**: 2 messages vs 30s time window (high-traffic groups differ)?
3. **Item 4 threshold value**: plan suggests 0.7 — what signal weights justify without silencing
   fandom-keyword-only triggers?
4. **Group B + TEMPLATE_FAMILY 2nd-fire order**: does Group B still evaluate on 2nd consecutive
   `又来了` (and pass to cooldown), or does cooldown pre-empt Group B check entirely?
5. **`贴贴` fandom allowlist**: does it qualify as fandom slang? Architect grep `data/lore` to pin.
