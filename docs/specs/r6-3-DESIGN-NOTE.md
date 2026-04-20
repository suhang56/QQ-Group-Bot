# R6.3 Replay Runner — Design Note

## §0 DELTA vs preserved draft (minimal-update pass, 2026-04-20)

**What changed:**
- Gold file reference updated throughout: `gold-298.jsonl` → `gold-493.jsonl`, row count 298 → 493 (no such refs existed in draft — confirmed clean)
- Distribution numbers inserted into §0 from PLAN (PLAN is now authoritative source)
- Planner's 6 open questions addressed below (Q1, Q2, Q4, Q6 resolved; Q3, Q5 deferred to Architect)
- `target-mismatch` predicate clarified: fires only when `targetMsgId` is non-null AND non-empty AND ≠ gold trigger id (handles defer empty-string edge case from PLAN)

**What did NOT change:**
- All tag names (kebab-case, 10 tags frozen) — unchanged
- All field names in `ReplayRow` / `ReplaySummary` — unchanged
- CLI flag shape (`--gold`, `--benchmark`, `--output-dir`, `--llm-mode`, `--limit`) — unchanged
- JSONL schema skeleton — unchanged
- Mock LLM stub contract (`[mock:<hex8>] 好的`) — unchanged
- Banter regex list — unchanged (Q4 resolved: current list is the FINAL seed; Architect extends if needed)
- File layout under `scripts/eval/` — unchanged

**Gold distribution (from PLAN, frozen, 493 total rows):**
- goldAct: silence 147 · chime_in 127 · relay 64 · object_react 51 · direct_chat 51 · meta_admin_status 30 · conflict_handle 13 · bot_status_query 9 · summarize 1
- goldDecision: reply 291 · silent 100 · defer 102
- flags: factNeeded 67 · allowBanter 181 · allowSticker 61
- silence+defer denominator for primary metric: 202

**Planner Q1 — utteranceAct classifier**: No src/ classifier exists that's safely callable without a full ChatModule. Stub `'unknown'` for R6.3 with `// TODO(R6.4): replace with real classifier` is ACCEPTABLE per Design. The R6.3 classifier in §5 (regex-based, pure, deterministic) is the approved stub.

**Planner Q2 — join key**: Gold field is `sampleId` (string, `${groupId}:${messageId}`). Benchmark field is `id` (see `scripts/eval/types.ts:64` `SampledRow.id`). Runner joins on `gold.sampleId === benchmark.id`. Both sides are strings; no coercion needed.

**Planner Q4 — banter regex seed list**: The §6 `BANTER_REGEXES` list (7 patterns) is the FINAL seed for R6.3. PLAN calls for 3–4 patterns minimum; this draft exceeds that. Architect may extend but not remove patterns without Designer sign-off. Tag semantics are frozen regardless of list length.

**Planner Q6 — violation tag string literals**: All 10 tags are published in §4 as `ViolationTag` union + `ALL_VIOLATION_TAGS` const array. Architect imports from `violation-tags.ts`; tests import the same const. This resolves the shared-const requirement.

**Planner Q3 (deferred to Architect)**: Mock DB seeding strategy (`:memory:` sqlite vs stubbed repos).
**Planner Q5 (deferred to Architect)**: Per-sample wall-clock timeout (recommended 10s in PLAN; Architect decides implementation).

---

Reference: Planner spec (Task #1, 4 sub-phases) + Task #2 open design questions.
Resolves: replay-output.jsonl row schema, summary.json structure, mock LLM stub
contract, violation tag strings & predicates, banter regex list.

Worktree: `D:/QQ-Group-Bot/.claude/worktrees/r6-3-replay/`
Branch: `feat/r6-3-replay-runner`

### Alignment with PLAN

- Runner entrypoint `scripts/eval/replay-runner.ts` — matches PLAN R6.3.1
- Pure tag fn `scripts/eval/violation-tags.ts` — matches PLAN R6.3.2
- Sanity script `scripts/eval/summarize-gold.ts` — matches PLAN R6.3.0
- Infrastructure-only HARD CONSTRAINT respected everywhere below — no schema
  choice forces a src/ runtime change; all new types live under `scripts/eval/`.
- Pipeline boundary: runner calls existing `IChatModule.generateReply(groupId,
  triggerMessage, recentMessages)` at `src/modules/chat.ts:155` and captures
  the `ChatResult` union defined at `src/utils/chat-result.ts:28`. Schema below
  is a flat-projection of that union — no ambient runtime change needed.

---

## 1. `replay-output.jsonl` — per-row schema (FINAL)

One JSON object per line. One line per gold sample. Same order as input
gold file (stable for diffing across runs). UTF-8, no BOM, LF line endings.

### 1.1 TypeScript schema

```ts
// scripts/eval/replay-types.ts  (new file, owned by Architect)

export type GoldAct =      // re-exported from scripts/eval/gold/types.ts
  | 'direct_chat' | 'chime_in' | 'conflict_handle' | 'summarize'
  | 'bot_status_query' | 'relay' | 'meta_admin_status'
  | 'object_react' | 'silence';

export type GoldDecision = 'reply' | 'silent' | 'defer';

/**
 * Flattened from ChatResult.kind. `error` is runner-internal — used when
 * generateReply() throws; row is still emitted so counts stay aligned with
 * input gold file length.
 */
export type ReplayResultKind =
  | 'reply' | 'sticker' | 'fallback' | 'silent' | 'defer' | 'error';

/**
 * Post-hoc utterance-act classification, computed by the runner from
 * ChatResult + reply text. R6.3-introduced field (not present in runtime).
 * Matches GoldAct value space so gold comparison is a simple equality check,
 * plus `unknown` and `none` for non-reply outcomes.
 *
 * Classifier is PURE and DETERMINISTIC (regex + reasonCode + guardPath).
 * Kept intentionally naive in R6.3 — tightening is out of scope (future work).
 */
export type UtteranceAct =
  | GoldAct          // direct_chat | chime_in | ... | silence
  | 'unknown'        // reply produced, classifier could not pick a label
  | 'none';          // bot did not produce any utterance (silent/defer/error)

export interface ReplayRow {
  // ----- identity -----
  sampleId: string;                    // mirrors GoldLabel.sampleId
  category: number;                    // 1..10 from SampledRow.category

  // ----- gold echo (for downstream joinless analysis) -----
  goldAct: GoldAct;
  goldDecision: GoldDecision;
  factNeeded: boolean;
  allowBanter: boolean;
  allowSticker: boolean;

  // ----- replay result (flat projection of ChatResult) -----
  resultKind: ReplayResultKind;
  reasonCode: string | null;           // ChatResult.reasonCode, null iff resultKind='error'
  utteranceAct: UtteranceAct;          // classifier output, 'none' for non-reply
  guardPath: string | null;            // ChatResult.meta.guardPath, null if absent
  targetMsgId: string | null;          // triggerMessage.messageId (for target-mismatch tag)

  // ----- fact / retrieval signals (null for non-reply) -----
  usedFactHint: boolean | null;        // ReplyMeta.usedFactHint
  matchedFactIds: number[] | null;     // ReplyMeta.matchedFactIds — empty [] if reply w/o match
  injectedFactIds: number[] | null;    // ReplyMeta.injectedFactIds — diagnostic

  // ----- content -----
  replyText: string | null;            // reply/fallback: text; sticker: cqCode; silent/defer/error: null
  promptVariant: string | null;        // ReplyMeta.promptVariant, null if absent

  // ----- diagnostics -----
  violationTags: string[];             // computeViolationTags() output; [] when compliant
  errorMessage: string | null;         // only when resultKind='error'; else null
  durationMs: number;                  // replay wall-clock per sample (diagnostic, not asserted)
}
```

### 1.2 Nullability rules (enforced, no `undefined` on wire)

| Field | reply | sticker | fallback | silent | defer | error |
|---|---|---|---|---|---|---|
| `reasonCode` | str | str | str | str | str | **null** |
| `utteranceAct` | classifier | `object_react` | `unknown` | `none` | `none` | `none` |
| `guardPath` | str\|null | null | null | null | null | null |
| `targetMsgId` | str | str | str | str | str | str |
| `usedFactHint` | bool | null | null | null | null | null |
| `matchedFactIds` | int[] | null | null | null | null | null |
| `injectedFactIds` | int[] | null | null | null | null | null |
| `replyText` | str | cqCode | str | null | null | null |
| `promptVariant` | str\|null | null | null | null | null | null |
| `errorMessage` | null | null | null | null | null | str |

**Wire invariant**: `JSON.stringify` — never emit `undefined`. Use explicit `null`
for missing fields. This is so downstream analysis can assume every key exists
on every row and use `row.field == null` as the "absent" test without
worrying about prototype pollution or missing keys.

### 1.3 Ordering / stability

- Rows emit in **gold file input order**. No sort. No shuffle.
- JSON key order inside each row: exactly the key order in `ReplayRow`
  interface above (matches how `JSON.stringify(obj)` serializes when obj is
  built by literal `{k1, k2, ...}`). Stable diffs across runs.
- LF line endings (`\n`), never CRLF. One row per line. No trailing newline
  after last row (matches node's `fs.createWriteStream().write(line + '\n')`
  last-flush convention).

### 1.4 `targetMsgId` semantics

Planner spec has `targetMsgId` at top-level of the row (not nested). Two
candidate meanings: (a) the `triggerMessage.messageId` (what the bot was
supposed to reply to), (b) `ChatResult.kind==='defer'`'s `targetMsgId` (the
message the defer reschedules against).

**DECISION (a) — always store the trigger's `messageId`.** Rationale:

- `target-mismatch` tag compares it to "gold sample's trigger messageId" per
  Planner. The comparison only makes sense if both sides mean the same thing
  (what the bot was replying-to, not what it deferred-to).
- The defer-specific `targetMsgId` is a runtime scheduling detail, not a
  replay measurement. If Architect wants that preserved, spill into a
  separate optional field `deferredUntilTargetMsgId` (non-normative; skip if
  not used by any tag).

---

## 2. `summary.json` — aggregate structure (FINAL)

Single JSON document. Pretty-printed (2-space indent) for human read — this
is a baseline artifact, not a high-volume wire format.

```ts
export interface ReplaySummary {
  generatedAt: number;                 // epoch seconds
  runnerVersion: string;               // e.g. 'r6.3.0' — bump on schema change
  llmMode: 'mock' | 'real' | 'recorded';
  goldPath: string;                    // absolute path, for reproducibility
  benchmarkPath: string;
  totalRows: number;                   // == gold file row count
  errorRows: number;                   // resultKind==='error'

  // --- Primary headline metric (Planner §Primary metric) ---
  silenceDeferCompliance: {
    denominator: number;               // |gold ∈ {silent,defer}|
    compliant: number;                 // bot resultKind ∉ {reply, sticker, fallback}
    rate: number;                      // compliant / denominator, 0..1, 4 decimal places
  };

  // --- Per-tag breakdown ---
  violationCounts: Record<ViolationTag, number>;   // every tag keyed, 0 if unseen
  violationRates: Record<ViolationTag, {
    denominator: number;               // rows where tag is *applicable*, per-tag rule
    hits: number;                      // rows that fired the tag
    rate: number;                      // hits / denominator (or 0 when denom=0)
  }>;

  // --- Distributions ---
  resultKindDist: Record<ReplayResultKind, number>;
  utteranceActDist: Record<UtteranceAct, number>;
  guardPathDist: Record<string, number>;           // 'none' key for null
  reasonCodeDist: Record<string, number>;          // 'none' key for null

  // --- Gold×Bot confusion (goldAct × utteranceAct) ---
  actConfusion: Record<GoldAct, Record<UtteranceAct, number>>;

  // --- Per-category breakdown (cat 1..10) ---
  perCategory: Array<{
    category: number;
    label: string;                     // from CATEGORY_LABELS
    rowCount: number;
    silenceDeferCompliance: { denominator: number; compliant: number; rate: number };
    violationCounts: Record<ViolationTag, number>;
  }>;
}
```

### 2.1 Denominator rules per tag (resolves Planner ambiguity)

| Tag | Denominator definition |
|---|---|
| `gold-silent-but-replied` | rows where `goldDecision === 'silent'` |
| `gold-defer-but-replied` | rows where `goldDecision === 'defer'` |
| `direct-at-silenced` | rows where `category === 1` |
| `fact-needed-no-fact` | rows where `factNeeded === true` AND `resultKind === 'reply'` |
| `fact-not-needed-used-fact` | rows where `factNeeded === false` AND `resultKind === 'reply'` |
| `sticker-when-not-allowed` | rows where `allowSticker === false` |
| `banter-when-not-allowed` | rows where `allowBanter === false` AND `resultKind === 'reply'` |
| `object-react-missed` | rows where `goldAct === 'object_react'` |
| `meta-status-misclassified` | rows where `goldAct === 'meta_admin_status'` AND `resultKind === 'reply'` |
| `target-mismatch` | rows where bot produced any non-silent/defer output (`resultKind ∈ {reply, sticker, fallback}`) |

Rows where denominator excludes them **do not** contribute to `hits` even if
the predicate technically fires on a zero-denominator row (belt-and-braces —
prevents accidental double-count when gold has weird combos).

### 2.2 Headline metric — `silenceDeferCompliance`

Per Planner: `|{gold∈(silent,defer) AND bot resultKind NOT reply}| / |gold∈(silent,defer)|`.

**Clarification**: "bot resultKind NOT reply" means bot produced no
user-visible message. Concretely `resultKind ∈ {silent, defer}`. Stickers,
fallbacks, and plain replies all count as non-compliant when gold wanted
silence/defer. Rationale: from user's POV a sticker is still "bot spoke."

`error` rows are **excluded from both numerator and denominator** so a
generateReply crash doesn't score as pass or fail. `errorRows` top-level
key tracks them for visibility.

---

## 3. Mock LLM stub — return contract (FINAL)

`--llm-mode=mock` is the default. Stub replaces the `callLLM`-class boundary
(exact seam is Architect's call — likely a replacement module export or a DI
override at chatModule construction time). Stub contract:

### 3.1 Stub behavior

```ts
// scripts/eval/mock-llm.ts
export function mockLLM(prompt: string): string {
  const h = sha1(prompt).slice(0, 8);   // hex8 — deterministic keying
  return `[mock:${h}] 好的`;
}
```

- **Keying**: SHA-1 of the full prompt string, first 8 hex chars. sha1 ships
  with node crypto — no dep needed. SHA-1 is fine here (not crypto use).
- **Return shape**: `"[mock:<hex8>] 好的"` — a short plain-text reply, fixed
  suffix so the bot's output-pipeline (sentinel, entity-guard, hardened-regen)
  has **real text to exercise**. Constant length means banter/sticker
  classifiers get the same surface every time.
- **Deterministic across runs**: same prompt → same output. Replaying the
  same gold file twice must produce byte-identical `replay-output.jsonl`
  (modulo `durationMs` which we normalize to `0` in regression tests — see §6).

### 3.2 Why `"好的"` suffix (not empty, not echo, not random)

| Option | Why rejected |
|---|---|
| Empty `""` | Triggers blank-reply guards → all replies become `silent`. Can't measure downstream classifier paths at all. |
| Echo prompt | Violates sentinel immediately → every reply becomes `hardened-regen`. Masks real guard paths. |
| Random | Non-deterministic; defeats whole point of mock. |
| `"好的"` | (i) short, ≤ sentinel length cap; (ii) Chinese reply — exercises CJK tokenizers; (iii) non-banter — `banter-when-not-allowed` false-positives stay near-zero on mock; (iv) persona-neutral — doesn't pre-trigger outsider-guard. |

The `[mock:<hex8>]` prefix is a SENTINEL the runner uses to detect
"mock-origin text" in downstream content when diagnosing guard behavior.
Production LLM responses will never contain this prefix, so its presence
unambiguously means "mock path."

### 3.3 `--llm-mode=real` and `recorded`

- `real` — calls the production LLM adapter. Dev does NOT need to wire this
  in R6.3; spec lists it for future compat. Stub behavior: throw
  `Error('--llm-mode=real not implemented in R6.3; use mock')`. Architect
  decides whether to stub as "not implemented" or skip the flag altogether.
- `recorded` — same treatment: throw-not-implemented. Reserved for future
  (load replay from a previously-recorded `.jsonl` cassette).

Only `mock` is required for R6.3 acceptance.

---

## 4. Violation tag strings & predicates (FINAL)

All tags are **kebab-case**, matching Planner's list verbatim. One
`ViolationTag` union type, one pure fn per tag, `|` composed in
`computeViolationTags`.

```ts
// scripts/eval/violation-tags.ts

export type ViolationTag =
  | 'gold-silent-but-replied'
  | 'gold-defer-but-replied'
  | 'direct-at-silenced'
  | 'fact-needed-no-fact'
  | 'fact-not-needed-used-fact'
  | 'sticker-when-not-allowed'
  | 'banter-when-not-allowed'
  | 'object-react-missed'
  | 'meta-status-misclassified'
  | 'target-mismatch';

export const ALL_VIOLATION_TAGS: readonly ViolationTag[] = [
  'gold-silent-but-replied',
  'gold-defer-but-replied',
  'direct-at-silenced',
  'fact-needed-no-fact',
  'fact-not-needed-used-fact',
  'sticker-when-not-allowed',
  'banter-when-not-allowed',
  'object-react-missed',
  'meta-status-misclassified',
  'target-mismatch',
] as const;
```

### 4.1 Predicate definitions (unambiguous)

"Bot produced reply" = `resultKind ∈ {reply, sticker, fallback}`. Shorthand
`outputted` in the table below. Silent/defer/error never count as
"outputted."

| Tag | Fires iff |
|---|---|
| `gold-silent-but-replied` | `gold.goldDecision === 'silent'` **AND** outputted |
| `gold-defer-but-replied` | `gold.goldDecision === 'defer'` **AND** outputted |
| `direct-at-silenced` | `row.category === 1` **AND** `resultKind === 'silent'` |
| `fact-needed-no-fact` | `gold.factNeeded === true` **AND** `resultKind === 'reply'` **AND** `matchedFactIds.length === 0` |
| `fact-not-needed-used-fact` | `gold.factNeeded === false` **AND** `resultKind === 'reply'` **AND** `matchedFactIds.length > 0` |
| `sticker-when-not-allowed` | `gold.allowSticker === false` **AND** `resultKind === 'sticker'` |
| `banter-when-not-allowed` | `gold.allowBanter === false` **AND** `resultKind === 'reply'` **AND** `matchesBanterRegex(replyText)` |
| `object-react-missed` | `gold.goldAct === 'object_react'` **AND** `resultKind === 'reply'` |
| `meta-status-misclassified` | `gold.goldAct === 'meta_admin_status'` **AND** `resultKind === 'reply'` **AND** `utteranceAct !== 'meta_admin_status'` |
| `target-mismatch` | outputted **AND** `row.targetMsgId != null` **AND** `row.targetMsgId !== ''` **AND** `row.targetMsgId !== String(gold.sampleId.split(':')[1])` |

Notes on predicates:

- `sampleId` format is `${groupId}:${messageId}` per `SampledRow.id`
  at `scripts/eval/types.ts:64`. `split(':')[1]` extracts the messageId
  string. The replay runner can short-circuit by loading the SampledRow
  from benchmark JSONL (which has raw `messageId` column) to avoid parsing.
- `fact-needed-no-fact` uses `matchedFactIds.length === 0` (bot had no
  real fact hit). `injectedFactIds` is diagnostic only — not used in
  this predicate. This mirrors R6.1 `hasRealFactHit` semantics.
- `object-react-missed` fires when gold wants a sticker-emoji-type reaction
  (`object_react`) but the bot produced a text reply. Sticker is the
  correct output for `object_react`; text is the miss. Fired on
  `resultKind === 'reply'`, **not** on `'fallback'` (fallbacks are sad-paths,
  different failure mode; separate future tag may cover fallback-in-object-react).

### 4.2 Ambiguity resolutions

**(a) What if gold conflicts with itself?** E.g. `goldDecision='silent'` but
`factNeeded=true`. Tags still fire per the pure predicate — the
`summarize-gold.ts` sanity script (R6.3.0) will surface these as suspicious
rows before they reach replay. Runner does not self-heal gold; garbage in,
garbage out is the correct R6.3 stance.

**(b) Fallback kind and violation attribution.** Fallback texts (`"嗯"`,
`"??"`) count as `outputted` for all tags. This is intentional — from a
silence-compliance perspective the bot still "spoke."

**(c) Silent defer and the defer tag.** `gold-defer-but-replied` does NOT
fire when bot produces `resultKind='silent'`. Silent is treated as
more-conservative-than-defer and thus compliant. Symmetric: if gold wants
silent and bot defers, `gold-silent-but-replied` does not fire (defer is
also non-output).

**(d) Tag count per row.** No cap. A single row can fire 5+ tags
simultaneously (`summary.json.violationCounts` is a per-tag tally, not a
per-row "has any tag" count — no double-counting concern).

---

## 5. `utteranceAct` classifier — algorithm

The R6.3-introduced post-hoc classifier. Naive, deterministic, pure.

```ts
// scripts/eval/classify-utterance.ts

export function classifyUtterance(
  result: ChatResult,
  gold: GoldLabel                    // unused in R6.3 — keeps signature future-proof
): UtteranceAct {
  if (result.kind === 'silent' || result.kind === 'defer') return 'none';
  if (result.kind === 'sticker') return 'object_react';         // sticker = object_react domain
  if (result.kind === 'fallback') return 'unknown';

  // reply path
  const t = result.text.trim();
  if (META_STATUS_RE.test(t)) return 'meta_admin_status';
  if (RELAY_ECHO_RE.test(t)) return 'relay';
  if (BOT_STATUS_RE.test(t)) return 'bot_status_query';
  // Naive default for mock-era: can't reliably distinguish chime_in from direct_chat
  // without full engagement-gate replay. Report 'unknown' to avoid false meta-status
  // misclassification signals in the headline compliance number.
  return 'unknown';
}
```

With regex constants (extend as mock corpus reveals gaps):

```ts
const META_STATUS_RE = /^(禁言|踢|警告|管理|群规|违规|删了|撤回|别在群里)/;
const RELAY_ECHO_RE  = /^(接|1|\+1|收到|来了)\s*$/;           // short relay tokens
const BOT_STATUS_RE  = /^(我|本喵|我的|这边)(在|刚刚|今天|没|还没|已经)/;
```

Importantly, the classifier is **not** expected to be accurate. It's
`meta-status-misclassified`'s discriminator only. `unknown` is a first-class
citizen in distributions and does not itself trigger any violation tag.

---

## 6. Banter regex list — `banter-when-not-allowed` (FINAL)

`allowBanter=false` means gold wants the bot to be **substantive, not
performative**. "Banter" patterns we reject:

```ts
// scripts/eval/banter-regex.ts

export const BANTER_REGEXES: readonly RegExp[] = [
  // Laugh-density — any one-or-more laugh token
  /哈哈/, /嘿嘿/, /嘻嘻/, /呵呵/, /笑死/, /草+(?!泥)/, /233+/,

  // Exclamation density (≥3 in short reply is performative)
  /[！!]{3,}/,

  // Casual-particle stacks
  /(啊|呀|呢|吧|哦|噢|嘛)\s*[！!。?？]*\s*(啊|呀|呢|吧|哦|噢|嘛)/,

  // Emoji burst (≥3 emoji-like chars in sequence)
  /(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]){3,}/u,

  // yyds / 绝绝子 / meme stamps
  /\byyds\b/i, /绝绝子/, /nb啊/i, /绝了/, /芜湖/, /奥利给/,

  // Repeated vowel stretch (跑啊啊啊啊)
  /(.)\1{3,}/,

  // Standalone single-char laughs
  /^\s*(哈|嘻|嘿|呵|笑)\s*$/,
] as const;

export function matchesBanterRegex(text: string): boolean {
  return BANTER_REGEXES.some(re => re.test(text));
}
```

### 6.1 Why these patterns (non-normative rationale)

- **Laugh density**: single `哈哈` is not banter; `哈哈` is. R6.3 goes with
  `/哈哈/` (2-char) as the threshold — one `哈` is often "oh I see,"
  `哈哈` is performative. `笑死` and `233` are meme-banter tells.
  `草+(?!*泥)` blocks 草/草草草 "lol" while not matching the `草泥马` insult
  (which is moderation territory, separate).
- **Exclamation**: `!!!` is emotive. `!` alone is not — commonplace for
  sincere replies. Threshold at 3.
- **Casual particles**: single 啊 is fine. Stacks like `啊啊` or
  `哦吧` read as performative.
- **Emoji burst**: ≥3 in a row = "hype." Single emoji in a factual reply
  is fine. Range covers Misc Symbols + Emoticons + Supplemental Symbols.
- **Meme stamps**: `yyds`/`绝绝子`/`芜湖`/`奥利给` — canonical Chinese
  internet banter stamps. Any occurrence = banter.
- **Vowel stretch**: `啊啊啊啊` / `hmmmm` / `哈哈哈哈哈哈哈` captured.
- **Bare laugh**: a one-char-reply `哈` standalone is almost always banter
  in a `allowBanter=false` context (substantive reply would have content).

### 6.2 Known false positives (accept for R6.3)

- Technical text containing `233` (port numbers, version strings). Acceptable
  false-positive rate in chat context — bot rarely emits those.
- `啊 好的` → particles-stack regex doesn't match (single `啊`, then non-
  particle). Correctly not banter.
- `笑死` as legit reaction in `allowBanter=true` context — not tagged because
  denominator filter excludes allowBanter=true rows.

The banter regex list is **not** a bot-behavior rule. It is a measurement
lens. Tuning belongs in a future R-milestone if baseline shows systematic
miscategorization.

---

## 7. File layout summary (for Architect)

New files under `scripts/eval/`:

```
scripts/eval/
├── replay-types.ts          # ReplayRow, ReplayResultKind, UtteranceAct, ReplaySummary
├── replay-runner.ts         # main CLI, --gold --benchmark --output-dir --llm-mode
├── mock-llm.ts              # deterministic stub, sha1 keyed
├── classify-utterance.ts    # post-hoc UtteranceAct classifier
├── violation-tags.ts        # ViolationTag, computeViolationTags()
├── banter-regex.ts          # BANTER_REGEXES, matchesBanterRegex()
├── summarize-gold.ts        # R6.3.0 sanity script
└── replay-side-effect-mocks.ts   # DB-readonly, adapter no-op, memory no-op
                                   # (Architect owns exact seam — may prefer DI)
```

New tests under `test/scripts/eval/`:

```
test/scripts/eval/
├── violation-tags.test.ts   # one unit test per tag (required per PLAN acceptance)
├── banter-regex.test.ts     # positive + negative cases per pattern
├── mock-llm.test.ts         # determinism, hex8 keying
├── classify-utterance.test.ts  # each ChatResult.kind → expected UtteranceAct
└── replay-row.test.ts       # serialization determinism, null-not-undefined invariant
```

`src/` touched: **none** (infrastructure-only HARD CONSTRAINT).

`src/test-mocks/` — only if Architect finds no way to replay
`chatModule.generateReply` without a test-DB seam. If so, justify in
DEV-READY; Reviewer will scrutinize.

---

## 8. Open items for Architect

These are implementation-seam questions Designer defers to Architect — the
choices below don't affect schema/tags/banter, only wiring.

1. **LLM seam location**: dependency-inject into `ChatModule` constructor?
   Module-level function swap? Environment variable? Designer prefers DI (one
   surface to mock, no ambient state).
2. **DB seam**: read-only open of production sqlite (copy file to tmp?) vs.
   build an in-memory minimal schema seeded from benchmark? Affects test
   hermeticity. Designer prefers tmp copy — avoids divergence from prod schema.
3. **Adapter / memory / expression-learner silencing**: do we pass an
   `outbound: NoopAdapter` into ChatModule, or gate at call-site with a flag
   (`replayMode: true`)? Designer prefers NoopAdapter + constructor injection
   to avoid adding conditionals in the hot path.
4. **`target-mismatch` parsing**: sampleId split is cheap. Architect may
   prefer to carry messageId through benchmark row object instead of
   re-parsing. Either works.
5. **Summary pretty-print**: `JSON.stringify(obj, null, 2)` vs compact.
   Designer picks pretty for human read; artifact is small.

None of these block Developer. All resolvable in DEV-READY.

---

## 9. Acceptance checklist (Designer's perspective)

- [x] `replay-output.jsonl` row schema fully typed, nullability defined per kind
- [x] `summary.json` structure covers headline metric + per-tag + distributions + confusion + per-category
- [x] Mock LLM return shape deterministic, hex8-keyed, non-empty, non-echo
- [x] All 10 violation tag strings kebab-case; all predicates unambiguous
- [x] Banter regex list concrete and testable
- [x] UtteranceAct classifier defined (required by `meta-status-misclassified`)
- [x] No src/ runtime change forced by schema
- [x] Open items for Architect are wiring-only, not spec

Handoff → Architect (Task #3).
