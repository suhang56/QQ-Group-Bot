# DESIGN-NOTE: R2.5.1 scope-guard unified

## Q-resolutions

| Q | Decision |
|---|---|
| Q1 Group B tail | `[啊了呢吧哦嗷哈]*[。.!?~～]*` appended; Group A hostile: `你们别(?:烦\|闹\|吵)[!！~～]*` |
| Q2 lookback | Last 2 msgs before bot's prev turn; match `[CQ:at,qq=${botUserId}]` OR `[CQ:reply,id=<bot-id>]` |
| Q3 threshold | `chatMinScore` `0.45`→`0.65`; env `R2_5_1_HIGHER_ENGAGE_THRESHOLD` (default true); false=keep 0.45 |
| Q4 order | Group B first; `prevBotTurnAddressed=false`→silent (TEMPLATE skipped); true→Group B pass→TEMPLATE evaluates count |
| Q5 贴贴 | `宝宝` lore-confirmed→ALLOWLIST if topic contains `lore:`; `贴贴` not in lore→purge; `晚安/早安`→purge |

---

## Group A — PLURAL_YOU_PATTERNS (refactor of SPECTATOR_PATTERNS)
Applied on compact (no-whitespace) bot output text:
```
/^\s*你们别(?:烦|闹|吵)[!！~～]*\s*$/
/你们事(?:真|都)?多/       /你们节目(?:真|都)?多/    /你们毛病(?:真|都)?多/
/你们真能折腾/             /你们又来了|你们又开始了|你们怎么又/
/有病(?:吧|啊)?你们|你们有病(?:吧|啊|么)?/
/^你们几个(?:又|真|怎么|在|搁|干嘛|干啥|有病|事)/
/你们都[^\s]{0,8}啊/
```
- Trigger: `speakerCount < 3 && !isDirect`
- Narrow escape: ≥2 distinct speakers with `CQ:at-bot` OR `CQ:reply-to-bot` in last 10 msgs

## Group B — SELF_CENTERED_SCOPE_CLAIM_PATTERNS (new)
Full-line anchor on bot output, embedded occurrence NOT matched:
```
/^\s*(?:又来了|又开始了|又来搞我|又在搞我|还来|又一次|有完没完)[啊了呢吧哦嗷哈]*[。.!?~～]*\s*$/
```
- Trigger: `!isAtMention && !isReplyToBot && !prevBotTurnAddressed`
- speakerCount-agnostic; single-fire (no count threshold)
- `prevBotTurnAddressed(history, botUserId): boolean` — sig exposed from `scope-claim-guard.ts`

## ANNOYED_TEMPLATE_FAMILY tokens
`烦死了 / 想屁吃呢 / 爱谁记谁记 / 你们别烦我 / 又来了 / 你烦不烦 / 你复读机 / 爱谁记谁 / 想屁吃`
Trigger: last-3 bot outputs ≥2 family hits AND candidate matches → regen-once → silent

---

## SendGuardCtx additions
- `recentHistory: ReadonlyArray<{userId:string;rawContent?:string;content:string;timestamp?:number}>` (needed for prevBotTurnAddressed; dNonBot already at chat.ts:2785)
- `speakerCount: number`

## isSocialPhrase(term) — new predicate in `src/utils/is-social-phrase.ts`
```
/^(?:我喜欢你|宝宝|晚安|早安|晚上好|贴贴|么么哒|抱抱)$/u
```
Script `scripts/purge-social-phrase-facts.ts`; scope `opus-classified:slang:%`; lore-topic rows exempt

## Replay tag predicates
- `self-centered-scope-claim`: Group B pattern on bot output && `!isAtMention && !isReplyToBot`
- `annoyed-template-consecutive`: `familyMatchCount(recentBotOutputs.slice(-3)) >= 2`

## Conflict
`isAddresseeScopeViolation` (sentinel.ts:696) covers Group A subset — extract both groups to new `src/utils/scope-claim-guard.ts`; sentinel re-exports for back-compat.
