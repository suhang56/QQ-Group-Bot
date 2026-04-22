# DEV-READY: R2.5.1 scope-guard unified

**Conflict resolution**: extract + re-export. `isAddresseeScopeViolation`(sentinel.ts:696) 签名保留,body 委托给 `hasPluralYouScopeClaim && d<3`。
**Callers grep-verified**(不改): `src/modules/chat.ts:53,2930,2936`;`test/addressee-scope-guard.test.ts:2,30-38`;`test/guards/scope-addressee-guard.test.ts:3,36-54`;`src/modules/guards/scope-addressee-guard.ts:14` doc-only。
Sentinel 是 leaf util;新 `scope-claim-guard.ts` 不 import sentinel → 无循环。

## 1. File changes

NEW:
- `src/utils/scope-claim-guard.ts` — Group A+B patterns + predicates + `prevBotTurnAddressed`
- `src/utils/social-phrase.ts` — `SOCIAL_PHRASE_ALLOWLIST` + `isSocialPhrase`
- `src/modules/guards/template-family-cooldown.ts` — `ANNOYED_TEMPLATE_FAMILY` + `isAnnoyedTemplateConsecutive`
- `scripts/maintenance/purge-social-phrase-facts.ts` — CLI(--db-path 必需 / --apply / --verbose)
- tests: `scope-claim-guard.test.ts` / `social-phrase.test.ts` / `purge-social-phrase-facts.test.ts` / `chat-scope-regen-2group.test.ts` / `engagement-threshold-flag.test.ts` / `violation-tags-scope-claim.test.ts`

MODIFY:
- `src/utils/sentinel.ts:696` — body 改为 `hasPluralYouScopeClaim(rawText) && d<3`(签名不变)
- `src/modules/chat.ts:2921-2956` — 拆 2 独立 if-block;+ TEMPLATE_FAMILY block 接 SF2 之后
- `src/modules/chat.ts:53` — 追加 `scope-claim-guard` / `template-family-cooldown` import
- `src/config.ts:175` — `chatMinScore` env-gated:`R2_5_1_HIGHER_ENGAGE_THRESHOLD!='false' ? 0.65 : 0.45`
- `src/utils/chat-result.ts:2-12,33` — `guardPath` +`'scope-claim-regen'|'template-family-regen'`;silent `reasonCode` +`'scope-claim-self-centered'|'scope-claim-plural-you'|'template-family-cooldown'`
- `scripts/eval/violation-tags.ts` — 2 new tags + 2 new ProjectedRow flags + 2 DENOMINATOR_RULES (() => true)
- `scripts/eval/replay-runner-core.ts:250-279` + `replay-summary.ts:122-145` — mirror-project 2 new flags

## 2. TypeScript signatures

```ts
// src/utils/scope-claim-guard.ts
export const PLURAL_YOU_PATTERNS: readonly RegExp[];          // Designer §3 Group A (incl hostile 你们别烦|闹|吵)
export const SELF_CENTERED_SCOPE_CLAIM_PATTERNS: readonly RegExp[]; // Designer §4 Group B full-line anchor
/** stripCQ + collapse whitespace, then PLURAL_YOU_PATTERNS.some */
export function hasPluralYouScopeClaim(rawText: string): boolean;
/** stripCQ + collapse whitespace, full-line anchored; embedded NOT matched */
export function hasSelfCenteredScopeClaim(rawText: string): boolean;
/**
 * True iff last 2 msgs BEFORE bot's most-recent own turn contained
 * `[CQ:at,qq=${botUserId}]` OR `[CQ:reply,id=<bot-msg-id>]`.
 * Returns false when bot has no prior turn (cold-start safe).
 */
export function prevBotTurnAddressed(
  history: ReadonlyArray<{userId:string;rawContent?:string;content:string;messageId?:string;timestamp?:number}>,
  botUserId: string,
): boolean;

// src/utils/social-phrase.ts
export const SOCIAL_PHRASE_ALLOWLIST: ReadonlySet<string>; // {我喜欢你,宝宝,晚安,早安,晚上好,贴贴,么么哒,抱抱}
export function isSocialPhrase(term: string): boolean;     // /^(?:我喜欢你|宝宝|晚安|早安|晚上好|贴贴|么么哒|抱抱)$/u

// src/modules/guards/template-family-cooldown.ts
export const ANNOYED_TEMPLATE_FAMILY: readonly string[];   // 9 tokens per DESIGN-NOTE §3
/** true iff >=2 of last-3 bot outputs contain any family token AND candidate contains one */
export function isAnnoyedTemplateConsecutive(
  candidate: string,
  recentBotOutputs: ReadonlyArray<{text:string}>,
): boolean;

// src/utils/sentinel.ts:696 — body only
export function isAddresseeScopeViolation(rawText: string, distinctNonBotSpeakers: number): boolean {
  return hasPluralYouScopeClaim(rawText) && distinctNonBotSpeakers < 3;
}
```

`SendGuardCtx` 不扩 — 新 guards 跟既有 `isAddresseeScopeViolation` 一样 inline 在 chat.ts,`immediateChron` / `distinctNonBotSpeakersImmediate` / `engagementSignals` 已就位。

## 3. SQL (只 purge script)

Schema grep-verified: `learned_facts.topic ✓ / .canonical ✓ / .status ✓ / .updated_at ✓`。
```sql
SELECT id, topic, canonical, fact, status FROM learned_facts
 WHERE status != 'rejected'
   AND (topic LIKE 'opus-classified:slang:%' ESCAPE '!'
     OR topic LIKE 'opus-rest-classified:slang:%' ESCAPE '!')
   AND topic NOT LIKE '%lore:%' ESCAPE '!';
-- --apply 路径:in-memory isSocialPhrase(canonical) filter → UPDATE
UPDATE learned_facts SET status='rejected', updated_at=? WHERE id=?;
```
No DELETE(`learned_facts_au` trigger 自动同步 FTS)。失败 rollback。

## 4. Integration — exact diffs

### 4a. chat.ts:53 import
Keep existing `isAddresseeScopeViolation` import unchanged(被 downstream guards 或未来 caller 潜在复用 — Dev 一行不改)。追加:
```ts
import { hasSelfCenteredScopeClaim, hasPluralYouScopeClaim, prevBotTurnAddressed } from '../utils/scope-claim-guard.js';
import { isAnnoyedTemplateConsecutive } from './guards/template-family-cooldown.js';
```

### 4b. chat.ts:2921-2956 — replace 既有 `{ const dSpeakers... isAddresseeScopeViolation... }` block

Shape(pseudo-diff;Dev 按原 block 的 try/catch/metaBuilder-setGuardPath/chatRequest(true) 风格):

```ts
{
  const dSpeakers = distinctNonBotSpeakersImmediate(immediateChron as any, triggerMessage, this.botUserId);
  const isAtMention = engagementSignals.isMention;
  const isReplyToBot = engagementSignals.isReplyToBot;

  // Group B — self-centered, speakerCount-agnostic, single-fire
  if (hasSelfCenteredScopeClaim(processed) && !isAtMention && !isReplyToBot
      && !prevBotTurnAddressed(immediateChron as any, this.botUserId)) {
    metaBuilder.setGuardPath('scope-claim-regen');
    const regen = await this._scopeRegenOnce(chatRequest, mfaceKeys, t=>hasSelfCenteredScopeClaim(t));
    if (!regen) return { kind:'silent', meta: metaBuilder.buildBase('silent'), reasonCode:'scope-claim-self-centered' };
    processed = regen;
  }
  // Group A — plural-you, existing trigger + hostile ext
  if (hasPluralYouScopeClaim(processed) && dSpeakers < 3 && !isDirect) {
    metaBuilder.setGuardPath('scope-claim-regen');
    const regen = await this._scopeRegenOnce(chatRequest, mfaceKeys, t=>hasPluralYouScopeClaim(t));
    if (!regen) return { kind:'silent', meta: metaBuilder.buildBase('silent'), reasonCode:'scope-claim-plural-you' };
    processed = regen;
  }
}
```

`_scopeRegenOnce(req, mfaceKeys, stillFails)` — 新 private method,抽提既有 :2933-2954 的 `chatRequest(true) + sanitize + applyPersonaFilters + stillFails check` 循环 1 次:pass 返回 text,fail 返回 null。复用,保持 regen-once-then-silent 语义。

### 4c. TEMPLATE_FAMILY — append AFTER SF2 self-echo block(chat.ts:2958-2985)

```ts
{
  const nowSecTF = Math.floor(Date.now()/1000);
  const botHist = this.selfEchoGuard.getRecent(groupId, nowSecTF);
  if (isAnnoyedTemplateConsecutive(processed, botHist)) {
    metaBuilder.setGuardPath('template-family-regen');
    const regen = await this._scopeRegenOnce(chatRequest, mfaceKeys,
      t => isAnnoyedTemplateConsecutive(t, botHist));
    if (!regen) return { kind:'silent', meta: metaBuilder.buildBase('silent'), reasonCode:'template-family-cooldown' };
    processed = regen;
  }
}
```

**顺序**(Designer Q4): Group B → Group A → SF2 → TEMPLATE → `runSendGuardChain`。
**Independence**:每 guard block early-return `silent` 仅代表"这个 guard fail",Group B pass 后 Group A 仍评估同 `processed`;Group A pass 后 SF2/TEMPLATE 仍评估。不 short-circuit = 每 block 独立判 current `processed`。

### 4d. config.ts:175
```ts
const R2_5_1_HIGH = process.env['R2_5_1_HIGHER_ENGAGE_THRESHOLD'] !== 'false';
export const lurkerDefaults = { ..., chatMinScore: R2_5_1_HIGH ? 0.65 : 0.45, ... } as const;
```

### 4e. chat-result.ts
```ts
guardPath?: ... | 'scope-claim-regen' | 'template-family-regen';
// silent reasonCode union:
  | ... | 'scope-claim-self-centered' | 'scope-claim-plural-you' | 'template-family-cooldown'
```

### 4f. violation-tags.ts
ViolationTag union 追加(declaration order,末尾):`'self-centered-scope-claim' | 'annoyed-template-consecutive'`;`ALL_VIOLATION_TAGS` 末尾 push 2 个。
ProjectedRow 追加:`selfCenteredScopeFired:boolean; templateFamilyFired:boolean;`。
computeViolationTags 追加(在 scope 块之后):
```ts
if (row.resultKind==='silent' && row.selfCenteredScopeFired) tags.push('self-centered-scope-claim');
if (row.resultKind==='silent' && row.templateFamilyFired)    tags.push('annoyed-template-consecutive');
```
DENOMINATOR_RULES 两个都 `() => true`(final-send filter,mirror sticker-leak)。

### 4g. replay-runner-core.ts:264-279 + replay-summary.ts:130-145
两处 mirror-add:
```ts
selfCenteredScopeFired: reasonCode === 'scope-claim-self-centered',
templateFamilyFired:    reasonCode === 'template-family-cooldown',
scopeGuardFired: ... || reasonCode === 'scope-claim-plural-you',  // preserve group-address-in-small-scene denom
```

## 5. Test contract(must-fire ≥15,must-NOT-fire ≥20)

### Must-FIRE (≥15)
scope-claim-guard.test.ts:
1. `hasPluralYouScopeClaim('你们事真多')` true
2. `hasPluralYouScopeClaim('你们别烦!')` true (hostile)
3. `hasPluralYouScopeClaim('你们都在说啥啊')` true
4. `hasPluralYouScopeClaim('你们 事 真 多')` true (whitespace)
5. `hasSelfCenteredScopeClaim('又来了')` true
6. `hasSelfCenteredScopeClaim('又开始了啊～')` true (tail)
7. `hasSelfCenteredScopeClaim('有完没完')` true
8. `hasSelfCenteredScopeClaim('[CQ:at,qq=1] 又来了')` true (stripCQ)
9. `prevBotTurnAddressed(hist-with-CQ:at-bot-window, botId)` true
10. `prevBotTurnAddressed(hist-with-CQ:reply-to-bot-msg, botId)` true

integration chat-scope-regen-2group:
11. Group A fires + regen passes → reply
12. Group B fires + regen fails → silent reasonCode='scope-claim-self-centered'
13. Group A fires + regen fails → silent reasonCode='scope-claim-plural-you'
14. TEMPLATE_FAMILY: 2-of-3 recent 含 family + candidate 含 → silent 'template-family-cooldown'
15. Group B passes, TEMPLATE fires on same text → silent TEMPLATE(独立性验证)

### Must-NOT-FIRE (≥20)
scope-claim-guard:
16. `hasSelfCenteredScopeClaim('又开始了在讨论音乐')` false (anchor)
17. `hasSelfCenteredScopeClaim('')` / `'   '` false
18. `hasSelfCenteredScopeClaim('我又来了')` false (prefix)
19. `hasSelfCenteredScopeClaim('又来了又开始了')` false (两 token concat)
20. `hasPluralYouScopeClaim('你们好多人啊讨论音乐呢')` false
21. `hasPluralYouScopeClaim('你们好')` false
22. `hasPluralYouScopeClaim('我们事真多')` false
23. `prevBotTurnAddressed([], 'bot')` false (cold-start)
24. `prevBotTurnAddressed(hist-no-bot-turn, botId)` false
25. `prevBotTurnAddressed(hist-has-bot-turn-but-window-no-CQ, botId)` false

integration:
26. Group B + isAtMention=true → bypass, `又来了` pass
27. Group B + isReplyToBot=true → bypass
28. Group B + prevBotTurnAddressed=true → bypass
29. Group A + `dSpeakers>=3` → bypass
30. TEMPLATE: 1-of-3 family → pass (count<2)

threshold-flag:
31. env 未设 → chatMinScore===0.65
32. `R2_5_1_HIGHER_ENGAGE_THRESHOLD=false` → 0.45

social-phrase + purge:
33. `isSocialPhrase('贴贴'|'宝宝'|'晚安')` true;`('ykn'|'Roselia'|'')` false
34. dry-run: 3 slang rows, canonical ∈ allowlist → found=3, updated=0
35. --apply: rows `status='rejected'`,updated=3
36. lore-topic exempt(`topic` 含 `lore:`) → skipped (`data/lore/958751334.md:19` 确认 `宝宝` 已 lore)
37. non-social canonical(`ykn`)→ isSocialPhrase=false → skipped

violation-tags:
38. silent + selfCenteredScopeFired=true → emit `self-centered-scope-claim`
39. reply + selfCenteredScopeFired=true → no emit (silent 门)
40. silent + templateFamilyFired=true → emit `annoyed-template-consecutive`

## 6. Acceptance + Reviewer spot-checks

**Dev DONE signal**:`npx tsc --noEmit` clean;`npx vitest run` ALL pass(paste last-10);replay-runner sample shows 2 new keys in `violationCounts`/`violationRates`;`group-address-in-small-scene` rate ↓。

**Reviewer 3 generic(all APPROVE mandatory)**:
- SC1 — `tsc` + `vitest run` green 本地(不信 dev paste);cold-run clean
- SC2 — grep proof:`isAddresseeScopeViolation` 签名 pre/post 一致,5 existing caller 测试原封通过
- SC3 — `aggregateSummary` 输出 `violationCounts`/`violationRates` 含 2 new keys,既有 keys 不丢

**R2.5.1-specific 3(per PLAN Open Qs)**:
- SC4 — **独立 regex + 独立 trigger**: 读 `scope-claim-guard.ts`,验证 `PLURAL_YOU_PATTERNS ∩ SELF_CENTERED_SCOPE_CLAIM_PATTERNS = ∅`;Group A trigger 用 `dSpeakers<3`,Group B 用 `prevBotTurnAddressed`(无 count);两 predicate 互不调用
- SC5 — **prevBotTurnAddressed 机械判定**: tests 9+10+23-25 覆盖 addressed-pass / cold-start / no-bot-turn / window-no-CQ;spot-run 一条带 addressee 的 `又来了`(Group B 必 bypass)+ 一条无 addressee(必 fire)
- SC6 — **TEMPLATE + Group B 独立不 short-circuit**: 追踪 §4b+§4c,3 reasonCode literal 不混;test 15 守护 Group B pass 后 TEMPLATE 仍跑;未来重构若合并 2 block 测试会 fail
