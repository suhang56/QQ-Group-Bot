# DEV-READY: R2.5 — Low-info dampener / self-amp guard / scope-addressee guard

## Architect Q-resolutions

**AQ1 — SF2 echo-exemption heuristic**: use **candidate-substring-in-user-trigger** check, not user-stem-present. Rationale: SF2 fires only when `candidate` contains EMOTIVE_RE stem; exemption asks "did user just say this stem?". Stem-in-user check is permissive (exempts every 累 in context) and defeats the guard; substring check (`triggerMessage.content.includes(candidate) || candidate.length >= 3 && triggerMessage.content.includes(candidate.slice(0,3))`) targets the actual echo pattern (bot empathy-echoes user's literal phrase). Cheap, no NLP.

**AQ2 — SF1 admin/command bypass**: SF1 runs in `_enqueueAtMention` direct-path (chat.ts:1585-1680 area) AFTER router.ts:712 `hard-bypass` gate already dispatched commands out (`isSlashCommand && commandIsRegistered` returns before reaching `_enqueueAtMention` at :709). MOD_APPROVAL_ADMIN DMs never hit GroupMessage router. **Conclusion: no re-check needed.** SF1 predicate is pure; caller asserts admin path is upstream. Document invariant in SF1 JSDoc.

**AQ3 — BotEmotiveHistory prune policy**: **prune-on-read**. Rationale: per-access cost is O(3); state footprint (~200 × ~3 = 600 entries) is trivial even without eviction. Prune-on-write adds branch to every `_recordOwnReply` call (~every reply) for negligible gain. Read is rarer (SF2 fires only post-LLM on direct path). Prune drops entries where `nowSec - entry.ts > 300` (5-min window).

---

## 1. File changes

### NEW
- `src/utils/emotive-stems.ts` — shared `EMOTIVE_STEMS` const + `EMOTIVE_RE` (extracted from is-emotive-phrase.ts:3-4 stems)
- `src/core/direct-cooldown.ts` — SF1 state + pure predicate
- `src/modules/guards/self-echo-guard.ts` — SF2 state + predicate + recorder
- `src/modules/guards/scope-addressee-guard.ts` — SF3 `isBotNotAddresseeReplied` predicate (SF3 你们-filter delegates to existing `isAddresseeScopeViolation`)
- `test/guards/direct-cooldown.test.ts`
- `test/guards/self-echo-guard.test.ts`
- `test/guards/scope-addressee-guard.test.ts`
- `test/utils/emotive-stems.test.ts`

### MODIFY
- `src/utils/is-emotive-phrase.ts` — replace inline stem list with `import { EMOTIVE_STEMS } from './emotive-stems.js'`; rebuild regexes from shared const (no behavior change)
- `src/modules/chat.ts`:
  - **Imports** (~line 53 block): `+ import { DirectCooldown } from '../core/direct-cooldown.js'; + import { SelfEchoGuard } from './guards/self-echo-guard.js'; + import { isBotNotAddresseeReplied } from './guards/scope-addressee-guard.js';`
  - **Class fields** (~line 992–1003 block, near `botRecentOutputs`/`consecutiveReplies`): instantiate `DirectCooldown(500)` + `SelfEchoGuard(200)` via constructor
  - **SF1 hook**: in `_enqueueAtMention` or `_runChatPipeline` direct-path, AFTER `isPureAtMention` early-return (chat.ts:1668) and BEFORE vision/LLM call (chat.ts:1671). Pseudocode below
  - **SF3 bot-not-addressee hook**: pre-LLM, adjacent to SF1 (same block). Cheap signals only, no LLM cost
  - **SF2 hook**: post-LLM sentinel, inserted BETWEEN existing addressee-scope guard block (chat.ts:2670-2696) and image-trigger guard (chat.ts:2698). Same regen-once-then-silent pattern
  - **Bot-output recording**: add `selfEchoGuard.record(groupId, processed, nowSec)` call inside `_recordOwnReply` (chat.ts:1230)
- `scripts/eval/violation-tags.ts` — add 4 tags to `ViolationTag` union + `ALL_VIOLATION_TAGS` + `computeViolationTags` + `DENOMINATOR_RULES`. Predicates read new `ProjectedRow` fields (see §2)

---

## 2. TypeScript signatures

```ts
// src/utils/emotive-stems.ts
export const EMOTIVE_STEMS = ['烦','气','累','困','崩','麻','无语','哭'] as const;
export const EMOTIVE_RE: RegExp = new RegExp(EMOTIVE_STEMS.join('|'));
export const EMOTIVE_ALLOWLIST: ReadonlySet<string> = new Set(['笑死','笑死我','死鬼']);

// src/core/direct-cooldown.ts
export interface DirectCooldownEntry { lastReplyAtSec: number; lastContent: string; }
export class DirectCooldown {
  constructor(capacity?: number);  // default 500
  get(groupId: string, userId: string): DirectCooldownEntry | undefined;
  record(groupId: string, userId: string, content: string, nowSec: number): void;
}
/** Pure. Returns true when the trigger should be dampened (silent or neutral ack). */
export function isRepeatedLowInfoDirectOverreply(
  strippedContent: string,
  entry: DirectCooldownEntry | undefined,
  nowSec: number,
  opts?: { windowSec?: number; maxLen?: number; minDiffChars?: number }
): boolean;
// fires when: entry && nowSec - entry.lastReplyAtSec < 60 && strippedContent.length ≤ 6
//             && charDiff(strippedContent, entry.lastContent) < 3
export const NEUTRAL_ACK_POOL = ['嗯','在','?','咋了','啥'] as const;
export function pickNeutralAck(): string;

// src/modules/guards/self-echo-guard.ts
export interface BotEmotiveEntry { text: string; ts: number; }  // ts in seconds
export class SelfEchoGuard {
  constructor(capacity?: number);  // default 200
  /** Prune-on-read: drops entries older than 5min before returning. */
  getRecent(groupId: string, nowSec: number): readonly BotEmotiveEntry[];
  record(groupId: string, text: string, nowSec: number): void;
}
/** Pure. candidate contains EMOTIVE_RE AND ≥2 of last 3 botHistory texts contain EMOTIVE_RE
 *  AND candidate is NOT a substring-echo of userTriggerContent (AQ1). */
export function isSelfAmplifiedAnnoyance(
  candidate: string,
  botHistory: readonly BotEmotiveEntry[],
  userTriggerContent: string,
): boolean;

// src/modules/guards/scope-addressee-guard.ts
export function isBotNotAddresseeReplied(
  isBotAt: boolean,
  isReplyToBot: boolean,
  hasFactTerm: boolean,
  hasBotStatusKeyword: boolean,
): boolean;
// reuse isAddresseeScopeViolation from src/utils/sentinel.ts:696 for 你们-filter (SF3)

// scripts/eval/violation-tags.ts additions
// ViolationTag += 'repeated-low-info-direct-overreply' | 'self-amplified-annoyance'
//              | 'group-address-in-small-scene' | 'bot-not-addressee-replied'
// ProjectedRow += dampenerFired: boolean; selfEchoFired: boolean;
//                 scopeGuardFired: boolean; botNotAddresseeFired: boolean
// computeViolationTags: push each tag when its matching row flag is true AND
//   outputted==silent (these are SILENCE-SUCCESS tags — fire on correctly-silenced
//   rows where dampener/guard ran, symmetric with direct-at-silenced-by-timing)
```

All 4 new tags fire on `resultKind === 'silent'` with matching reasonCode (see §4); denominator = `category === 1` for SF1/SF3 direct-path tags, `outputted in ('reply','silent')` for SF2.

---

## 3. SQL

None. All state in-memory (BoundedMap). Explicit non-goal per PLAN scope-out #5.

---

## 4. Integration points (exact line numbers)

### SF1 + SF3 bot-not-addressee hooks — chat.ts direct path
Insertion point: **chat.ts:1668** (immediately AFTER `isPureAtMention` return, BEFORE vision at :1671). Pre-LLM — no model cost on fire.
- **SF1**: gate on `isDirectForGateBypass && !hasFactTerm && !isDirectQuestion(stripped) && isRepeatedLowInfoDirectOverreply(stripped, cdEntry, nowSec)` → `Math.random() < 0.5 ? silent(reasonCode:'dampener') : reply(pickNeutralAck(), reasonCode:'dampener-ack')`. Log `{ tag: 'repeated-low-info-direct-overreply' }`.
- **SF3 bot-not-addressee**: build `hasBotAt` (CQ:at regex vs botUserId), `hasReplyToBot` (CQ:reply + recent-bot-msg check mirroring chat.ts:1586-1590), `hasBotStatusKw` = `/bot|机器人|你(?:在|醒|睡|忙|好)/.test(stripped)`. If `isBotNotAddresseeReplied(...)` → silent(reasonCode:'scope'). Log `{ tag: 'bot-not-addressee-replied' }`.
- `hasFactTerm` computation: reuse `extractCandidateTerms(stripped).some(t => isValidStructuredTerm(t))` (already imported chat.ts:30 equivalent) OR lift from pre-LLM signal if already computed upstream — Dev picks the cheaper reuse.

### SF2 hook — post-LLM sentinel
Insertion point: **chat.ts:2696** (directly after addressee-scope guard block `}` on :2696, before :2698 image-trigger check). Mirror scope-guard regen-once-then-silent pattern (chat.ts:2682-2694):
- Call `this.selfEchoGuard.getRecent(groupId, nowSec)`, run `isSelfAmplifiedAnnoyance(processed, history, triggerMessage.content)`
- On fail: `metaBuilder.setGuardPath('self-echo-regen')`; `chatRequest(true)` → re-check predicate → silent(reasonCode:'self-echo') if still fails OR regen throws
- On pass: assign regen to `processed`, fall through to remaining sentinel chain
- Log `{ tag: 'self-amplified-annoyance' }`

### Recording hooks
- **Self-echo history**: append `this.selfEchoGuard.record(groupId, reply, Math.floor(Date.now()/1000))` at the top of `_recordOwnReply` (chat.ts:1230), right before `botRecentOutputs` mutation
- **Direct cooldown**: consolidate via new helper `_maybeRecordDirectCooldown(result, triggerMessage, groupId, isDirect)` invoked in the `finally` block at chat.ts:2854. Records iff `isDirect && result.kind !== 'silent' && result.reasonCode !== 'dampener-ack'` (the ack path records inline to get its own content into `lastContent`).

### Eval tagger — scripts/eval/violation-tags.ts
Extend `ProjectedRow` with 4 booleans (`dampenerFired`, `selfEchoFired`, `scopeGuardFired`, `botNotAddresseeFired`) populated by replay harness from `reasonCode`/`meta.guardPath`. Add 4 tag push branches in `computeViolationTags` (precedent: R2a cause-split at violation-tags.ts:84-87). Add 4 denominator rules to `DENOMINATOR_RULES`.

---

## 5. Test contract (vitest)

### `test/utils/emotive-stems.test.ts`
1. `EMOTIVE_RE.test('烦死了') === true`
2. `EMOTIVE_RE.test('哈哈') === false`
3. `isEmotivePhrase('烦死了') === true` (parity preserved post-refactor)
4. `EMOTIVE_ALLOWLIST.has('笑死') === true` (escape hatch preserved)

### `test/guards/direct-cooldown.test.ts` (SF1)
1. **first-@ no-cooldown** — entry undefined → predicate false (no dampening on first hit)
2. **inside-60s repeat short** — `entry.lastContent='烦死了'`, new content='不要烦', `nowSec - lastReplyAtSec = 30`, len ≤ 6 → true
3. **outside-60s** — 61s elapsed → false
4. **long content** — 15-char message → false (stripped.length > 6)
5. **new-topic diff** — `entry.lastContent='你好'`, new='ykn 最新单'(char-diff ≥ 3) → false
6. **same user, short, within window** → true
7. **BoundedMap eviction** — set 501 entries → oldest evicted (capacity honored)
8. **pickNeutralAck** — always returns a string from NEUTRAL_ACK_POOL (stochastic, run 20 iters)

### `test/guards/self-echo-guard.test.ts` (SF2)
1. **fewer than 2 stems in history** → false (1 of 3 contain 烦)
2. **2 of 3 stems + candidate has stem** → true
3. **candidate has no stem** → false regardless of history
4. **echo exemption (AQ1)** — candidate='累' AND triggerContent includes '累死了' → false
5. **allowlist bypass** — history=['笑死','笑死我','笑死'], candidate='笑死' → false (EMOTIVE_RE doesn't match allowlist literally — verify 笑 not in stems)
6. **prune-on-read** — record 3 entries, advance clock 400s, getRecent returns [] (5-min window)
7. **bounded history per group** — record 5 entries, getRecent returns last 3 only
8. **empty history** → false (no amplification pattern possible)

### `test/guards/scope-addressee-guard.test.ts` (SF3)
1. **bot @'d** — `isBotNotAddresseeReplied(true, false, false, false) === false`
2. **reply-to-bot** — `(false, true, false, false) === false`
3. **fact-term present** — `(false, false, true, false) === false`
4. **bot-status keyword** — `(false, false, false, true) === false`
5. **none of the above** — `(false, false, false, false) === true` (silent path fires)
6. **你们 + small scene** — `isAddresseeScopeViolation('你们几个烦死了', 2) === true` (existing; regression guard)
7. **你们 + large scene** — `isAddresseeScopeViolation('你们几个烦死了', 4) === false` (≥3 speakers, safe)

### `test/eval/violation-tags.test.ts` (extend existing)
- Add 4 fixtures (one per new tag); verify each fires iff corresponding ProjectedRow flag + denominator match.

---

## 6. Replay runbook — baseline capture

```bash
cd D:/QQ-Group-Bot/.claude/worktrees/r2-5-dampener-scope
NODE_OPTIONS=--experimental-sqlite npx tsx scripts/eval/replay-runner.ts \
  --input data/eval/gold-48.jsonl \
  --output data/eval/r2-5-baseline.jsonl
NODE_OPTIONS=--experimental-sqlite npx tsx scripts/eval/metrics.ts \
  --input data/eval/r2-5-baseline.jsonl > data/eval/r2-5-baseline-metrics.txt
```

Expected new tags appear in output: `repeated-low-info-direct-overreply`, `self-amplified-annoyance`, `group-address-in-small-scene`, `bot-not-addressee-replied`. Counts may be 0 on current 48-sample gold (SF2/SF3 target live-bug patterns not yet in gold set) — establishes baseline; real validation in live replay post-merge.

Invariant checks (must hold vs master):
- `direct-at-silenced-by-timing` still 0/48
- `silence_defer_compliance` ≥ 95% (PLAN acceptance)
- aggregate violation rate does not regress (existing 40/48)

---

## 7. Acceptance gate

### Dev checklist
- [ ] `tsc --noEmit` clean; paste raw last-10-lines
- [ ] `npm test` all pass; paste raw last-10-lines
- [ ] All 10 PLAN edge cases covered by new vitest tests (map test IDs in PR body)
- [ ] 3 Architect-discovered edges covered: prune-on-read, BoundedMap eviction, echo-exemption substring
- [ ] Replay baseline captured per §6; delta report posted
- [ ] `_recordOwnReply` calls `selfEchoGuard.record` (grep-verify)
- [ ] Every direct non-silent return path calls `directCooldown.record` (grep-verify via helper)
- [ ] `is-emotive-phrase.ts` imports from new `emotive-stems.ts` (no duplicate consts)
- [ ] No `.claude/` / Co-Authored-By in commits

### Reviewer checklist
- [ ] Rerun tsc + vitest independently; raw output evidence
- [ ] Grep: no second copy of EMOTIVE_STEMS outside `src/utils/emotive-stems.ts`
- [ ] Diff SF1/SF2/SF3 hooks: insertion at §4 specified line numbers ± small drift
- [ ] Confirm SF1/SF3 run BEFORE vision/LLM (no LLM cost on dampener fire)
- [ ] Confirm SF2 regen-once-then-silent mirrors addressee-scope guard pattern (chat.ts:2682-2694)
- [ ] Spot-check replay baseline output: 4 new tags present in `ALL_VIOLATION_TAGS` export
- [ ] No persistent DB writes (PLAN scope-out #5)
- [ ] No change to `_classifyPath` / `classify-path.ts` (PLAN scope-out #1)
