# DESIGN-NOTE: R2.5 — Low-info dampener / self-amplification guard / scope-addressee guard

## Q-resolutions

1. **SF2 placement**: sentinel-only (post-LLM). Prompt-layer hint wastes tokens; sentinel is cheaper and consistent with existing 8-sentinel precedent. No prompt-layer hint.
2. **SF1 "low-info" metric**: `stripped.length ≤ 6` after CQ-strip AND same userId AND within 60s. New-topic check (Q2/Q7 edge): if content tokens differ ≥3 chars from last trigger content → pass through (not dampened). Simple string diff, no embeddings.
3. **SF3 placement**: sentinel-only. Reuse `isAddresseeScopeViolation` (sentinel.ts:696) for 你们 filter. `@target != bot` silent path also post-LLM (consistent).
4. **EMOTIVE_STEMS**: extract into `src/utils/emotive-stems.ts` shared const. No import cycle: utils/ → utils/ is safe. No duplication.
5. **Speaker-count source**: `distinctNonBotSpeakersImmediate` already exists (chat.ts:63). Reuse for SF3. For SF1/SF2 no speaker-count needed — they are per-user/per-bot-output checks.

---

## Surface: State shapes

### SF1 — per-(groupId, userId) direct cooldown
```ts
// key: `${groupId}:${userId}`
type DirectCooldownEntry = {
  lastReplyAtSec: number;   // unix seconds
  lastContent: string;      // CQ-stripped content of last trigger that got a reply
};
const directCooldownMap = new BoundedMap<string, DirectCooldownEntry>(500);
```
- GC: BoundedMap(500) evicts LRU automatically — no extra GC needed
- Key format: `${groupId}:${userId}` (matches existing R2c `lastBotReplyAtSec` key convention)

### SF2 — per-groupId bot-output emotive history
```ts
// key: groupId
type BotEmotiveHistory = { texts: string[]; windowStartSec: number };
const botEmotiveHistoryMap = new BoundedMap<string, BotEmotiveHistory>(200);
```
- Retain last N=3 bot outputs within 5-min window; prune on each access

### Shared const — `src/utils/emotive-stems.ts`
```ts
export const EMOTIVE_STEMS = ['烦', '气', '累', '崩', '麻', '无语'] as const;
export const EMOTIVE_RE = new RegExp(EMOTIVE_STEMS.join('|'));
```

---

## Surface: Sentinel predicates (pure functions, R6.4 tags)

```ts
// tag: repeated-low-info-direct-overreply
isRepeatedLowInfoDirectOverreply(content: string, entry: DirectCooldownEntry | undefined, nowSec: number): boolean
// true when: entry exists + nowSec - entry.lastReplyAtSec < 60 + stripped.length ≤ 6
//            AND content token diff from entry.lastContent < 3 chars

// tag: self-amplified-annoyance
isSelfAmplifiedAnnoyance(candidate: string, botHistory: string[]): boolean
// true when: candidate matches EMOTIVE_RE + ≥2 of last 3 botHistory entries match EMOTIVE_RE

// tag: group-address-in-small-scene
isGroupAddressInSmallScene(text: string, dSpeakers: number): boolean
// delegates to existing isAddresseeScopeViolation(text, dSpeakers) — no new logic

// tag: bot-not-addressee-replied
isBotNotAddresseeReplied(isBotAt: boolean, isReplyToBot: boolean, hasFactTerm: boolean, hasBotStatusKeyword: boolean): boolean
// true when: !isBotAt && !isReplyToBot && !hasFactTerm && !hasBotStatusKeyword
```

---

## Surface: Neutral ack pool

```ts
export const NEUTRAL_ACK_POOL = ['嗯', '在', '?', '咋了', '啥'] as const;
```
- Fixed pool, no per-group variant (consistent with existing fixed deflection pools)
- Pick via `Math.random()` at call site (same pattern as ATSPAM_CURSE_POOL)

---

## Surface: Log events (pino)

```ts
// SF1 fire
logger.info({ groupId, userId, content, lastReplyAtSec, nowSec, tag: 'repeated-low-info-direct-overreply' }, 'dampener_fired');

// SF2 fire
logger.info({ groupId, candidate, botHistorySnippet: botHistory.slice(-3), tag: 'self-amplified-annoyance' }, 'self_echo_guard_fired');

// SF3 你们 filter
logger.info({ groupId, dSpeakers, processed, tag: 'group-address-in-small-scene' }, 'scope_guard_fired');

// SF3 bot-not-addressee silent
logger.info({ groupId, userId, tag: 'bot-not-addressee-replied' }, 'scope_guard_fired');
```

---

## Conflicts with existing convention

- NONE. All state maps follow BoundedMap pattern. Sentinel placement follows existing post-LLM sentinel chain. Log event names follow `*_fired` convention.

## Open questions for Architect

- SF2 exemption: "user quotes bot's own emotive word back" — Architect to decide detection heuristic (check if candidate overlaps with triggerMessage.content verbatim substring ≥ 3 chars)
- SF1 bypass list (admin/command/moderation) — Architect to wire into existing `isAdminCommand` / `isCommand` guards pre-dampener
- BotEmotiveHistory window reset policy: prune by `windowStartSec` on read or on write? Architect decides.
