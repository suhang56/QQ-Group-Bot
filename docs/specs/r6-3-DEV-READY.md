# R6.3 Replay Runner — DEV-READY

**Architect sign-off date**: 2026-04-19 (initial), 2026-04-20 (minimal-update pass)
**Worktree**: `D:/QQ-Group-Bot/.claude/worktrees/r6-3-replay/`
**Branch**: `feat/r6-3-replay-runner`
**Scope**: `scripts/eval/*` (new files only) + `test/eval/*` (new files only) + `docs/eval/replay-runner.md` + `.gitignore` additions.
**HARD CONSTRAINT**: zero runtime changes under `src/`. No prompt edits, no decision-threshold tuning, no StrategyDecision/fact-retrieval/FTS change, no LLM model swap. Smoke-run violations are DATA, not bugs for this cut.

Upstream: `docs/specs/r6-3-PLAN.md` (authoritative scope, 4 sub-phases R6.3.0–R6.3.3) · `docs/specs/r6-3-DESIGN-NOTE.md` (ReplayRow/ReplaySummary/ViolationTag/BANTER_REGEXES/mock-LLM contract; §0 DELTA carries Designer resolutions).

---

## 0. §0 DELTA vs preserved draft (minimal-update pass, 2026-04-20)

**Changed:** (1) `gold-298.jsonl` → `gold-493.jsonl` throughout (CLI §7.1/§7.2, runbook §10.2, pre-flight §10.1, progress example `40/298` → `40/493`); (2) flag counts realigned to PLAN: `67/493` `181/493` `61/493` (was `67/298` `180/298` `45/298`); (3) summary size `≤ ~8 KB` → `≤ ~13 KB`; (4) `target-mismatch` predicate (§6.3) gains `targetMsgId !== ''` guard per Designer §4.2(d); (5) §13 trimmed (Q3/Q5 moved out).

**Unchanged:** §1 file layout; §2 `ReplayRow`/`ReplaySummary`/`ReplayerArgs` schemas; §4 mock-LLM contract `[mock:<hex8>] 好的` + SHA-1; DESIGN §6 banter seed list (7 patterns); §7 CLI flag shape; §0.2 tmp-copy DB, §0.3 no-setter wiring, §0.4 `targetMsgId`-from-trigger.

**Added:** §0.Q3 (DB seed: tmp-copy `node:sqlite`), §0.Q5 (timeout: `Promise.race`+`setTimeout`, 10s default, `--timeout-ms` override). Designer DELTA resolutions (utteranceAct `'unknown'` stub, join `gold.sampleId ↔ benchmark.id`, banter seed frozen, `ViolationTag`+`ALL_VIOLATION_TAGS`, target-mismatch empty-string) now explicit.

**Grep-verified symbols (file:line):**
- `src/modules/chat.ts:155` — `IChatModule.generateReply(groupId, triggerMessage, _recentMessages): Promise<ChatResult>`
- `src/modules/chat.ts:1055-1056` — `constructor(private readonly claude: IClaudeClient, ...)`; `src/modules/chat.ts:1539` — `async generateReply(...)` impl
- `src/modules/chat.ts:4` — `import type { IClaudeClient } from '../ai/claude.js'`
- `src/core/router.ts:724,786,968,981,1114,1125,1223` — `evaluatePreGenerate`+`generateReply` call sites (runner BYPASSES router)
- `src/utils/chat-result.ts:1,15,28` — `BaseResultMeta`, `ReplyMeta`, `ChatResult` union
- `scripts/eval/types.ts:63-64` — `SampledRow.id = "${groupId}:${messageId}"` (join-key)
- No `setUtteranceAct`/`metaBuilder.setUtteranceAct` in src/ (confirms stub-only classifier)
- `package.json` scripts: `NODE_OPTIONS=--experimental-sqlite` ⇒ `node:sqlite` DB driver (informs §0.Q3)

---

## 0.Q3 — Mock DB seeding (Architect resolution)

**DECISION: Tmp-copy prod sqlite via `fs.copyFileSync`, open with `node:sqlite` `DatabaseSync` (project's DB driver per `package.json` `--experimental-sqlite` flag), `fs.rmSync` on exit.** Prefer over `:memory:` seed helper or stubbed repository interfaces.

Rationale: (a) same driver ⇒ zero schema translation; `:memory:` reseeds from `src/storage/schema.sql` per run (drift risk, memory `feedback_sqlite_schema_migration`); stubbed repos re-implement ~12 read-only surfaces (`messages.getRecent`, `learned_facts.searchByKeywords`, `lore.listActive`, `alias.listAliasFactsForMap`, `mood.getByUser`, `admins.getAdminsByGroup`, `affinity.getAll`, `memoryDigest.getTopByGroup`, `groupConfig`/`botMeta`/`recentOutputs`/`deflect`) — maintenance tax, zero gain. (b) `MoodTracker.flush` on `destroy()` lands in tmp copy; runner asserts `tmpDb.includes('.tmp/replay-')` before opening (§3.3 step 5). (c) Cleanup: `fs.rmSync` finally + `process.on('exit', …)`; `.tmp/` gitignored. Runner imports `DatabaseSync from 'node:sqlite'` — no `src/` change.

---

## 0.Q5 — Per-sample wall-clock timeout (Architect resolution)

**DECISION: `Promise.race([generateReply(...), rejectAfterMs(timeoutMs)])`, default `10_000` ms, overridable via `--timeout-ms`. On timeout: `resultKind='error'`, `errorMessage='timeout after <N>ms'`; runner continues.**

Helper (`scripts/eval/replay-runner-core.ts`) — `t.unref?.()` MUST be called per memory `feedback_timer_unref`:

```ts
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | null = null;
  const timeoutP = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms);
    t.unref?.();
  });
  return Promise.race([p, timeoutP]).finally(() => { if (t) clearTimeout(t); });
}
```

`AbortController` rejected: would require `AbortSignal` param on `generateReply` (src/ change banned); mock LLM has nothing real to abort. 10s default is ~1000× mock-LLM headroom. CLI `--timeout-ms` + `ReplayerArgs.perSampleTimeoutMs` both already in §7.1/§2.

---

## 0. Resolutions to Designer Open Items (§8)

| # | Designer question | Decision |
|---|---|---|
| 1 | LLM seam location | **DI into `ChatModule` constructor (first arg `claude: IClaudeClient`).** ChatModule already takes `IClaudeClient` as ctor arg 1 (`src/modules/chat.ts:1056`). Replay runner constructs a new `MockClaudeClient` (implements `IClaudeClient`) and passes it in. No module-level swap, no env var, no ambient state. Zero src/ change. |
| 2 | DB seam | **Tmp-copy production sqlite.** On runner start: `fs.copyFileSync(prodDbPath, data/eval/replay/.tmp/replay-<pid>.db)`. Construct real `Database` against the copy. On exit: `fs.rmSync`. Avoids schema drift (matches Designer preference); writes that leak (e.g. `MoodTracker.flush` on `destroy()`) land in the tmp copy, not prod. **Critical**: prod bot.db path must NEVER be passed directly. Runner asserts `dbPath.includes('.tmp/replay-')` before constructing Database. |
| 3 | Adapter / memory / expression-learner silencing | **No setters called during ChatModule wiring.** `selfLearning` option is `null`, `expressionSource`/`styleSource`/`relationshipSource`/`honestGapsSource`/`honestGapsTracker` sources left unset (nullable, chat.ts handles via `?.`). No setter = no writer wired = impossible to write. Background timers (`moodProactiveTimer`, `deflectRefillTimer`) are disabled via `moodProactiveEnabled: false` + `deflectCacheEnabled: false` ctor options. |
| 4 | `target-mismatch` parsing | **Carry `messageId` directly on `ReplayRow.targetMsgId` from the trigger `GroupMessage`.** No re-parse of sampleId. Runner extracts `triggerMessage.messageId` when building the fixture; stores as-is. |
| 5 | Summary pretty-print | **`JSON.stringify(summary, null, 2)`.** Small artifact (≤ ~13 KB at 493 rows); human-read is the use case. |

---

## 1. Module Layout

All new files. Zero `src/` edits.

```
scripts/eval/
├── replay-types.ts            # ReplayRow, ReplaySummary, ReplayResultKind,
│                              #   UtteranceAct, ReplayerArgs, IReplayCounters
├── mock-llm.ts                # MockClaudeClient : IClaudeClient (deterministic, sha1-keyed)
├── classify-utterance.ts      # classifyUtterance(result, gold) → UtteranceAct
├── violation-tags.ts          # ViolationTag union, ALL_VIOLATION_TAGS,
│                              #   computeViolationTags(gold, row), DENOMINATOR_RULES
├── banter-regex.ts            # BANTER_REGEXES, matchesBanterRegex(text)
├── replay-fixture-builder.ts  # buildTriggerFromBenchmark(SampledRow) → {groupId, triggerMessage, recentMessages}
├── replay-runner-core.ts      # constructChatModule(), runReplayRow(), aggregateSummary() — testable w/o CLI
├── replay-runner.ts           # CLI entrypoint: argparse, tmp-db lifecycle, stream output
├── summarize-gold.ts          # R6.3.0 CLI (audit only, stderr printout, exit 0)
└── replay-cli-args.ts         # shared arg parser for summarize-gold + replay-runner

test/eval/
├── violation-tags.test.ts     # ≥1 positive + ≥1 negative per tag (10 tags)
├── banter-regex.test.ts       # positive + negative cases per pattern
├── mock-llm.test.ts           # determinism, hex8 keying, no mutation
├── classify-utterance.test.ts # every ChatResult.kind branch
├── replay-row.test.ts         # JSON.stringify determinism, null-not-undefined invariant
├── replay-runner-mock.test.ts # integration: 2 synthetic gold rows → 2 replay rows, zero side-effect assertions
└── summarize-gold.test.ts     # smoke: 5 synthetic rows → exit 0 + stderr contains all 4 suspicious-row categories

docs/eval/
└── replay-runner.md           # usage + ReplayRow/ReplaySummary field reference
                               # (supplement to docs/eval/schema.md — R6.3 section)

.gitignore additions:
data/eval/replay/*.jsonl
data/eval/replay/*.json
data/eval/replay/.tmp/
```

Design NOT taken:
- **No `src/test-mocks/` directory**. DI via `IClaudeClient` interface alone covers the mock seam — no new shared dir needed. Planner §Scope allowed this path only if unavoidable; it is avoidable.
- **No in-memory `:memory:` sqlite + schema reseed**. Tmp-copy is simpler and more faithful (Designer §8.2 preference).

---

## 2. Types — `scripts/eval/replay-types.ts`

Canonical copy — Developer types everything else against these. Re-export `GoldAct`, `GoldDecision`, `GoldLabel` from `scripts/eval/gold/types.ts`. Re-export `SampledRow`, `ContextMessage` from `scripts/eval/types.ts`.

```ts
import type { GoldAct, GoldDecision, GoldLabel } from './gold/types.js';
import type { SampledRow } from './types.js';
import type { ChatResult } from '../../src/utils/chat-result.js';

export type ReplayResultKind =
  | 'reply' | 'sticker' | 'fallback' | 'silent' | 'defer' | 'error';

export type UtteranceAct =
  | GoldAct            // direct_chat | chime_in | ... | silence
  | 'unknown'          // reply produced, classifier could not label
  | 'none';            // bot produced no user-visible utterance

export interface ReplayRow {
  // identity
  sampleId: string;
  category: number;
  // gold echo (for joinless downstream analysis)
  goldAct: GoldAct;
  goldDecision: GoldDecision;
  factNeeded: boolean;
  allowBanter: boolean;
  allowSticker: boolean;
  // replay result
  resultKind: ReplayResultKind;
  reasonCode: string | null;
  utteranceAct: UtteranceAct;
  guardPath: string | null;
  targetMsgId: string | null;        // triggerMessage.messageId, not defer's target
  // fact / retrieval signals
  usedFactHint: boolean | null;
  matchedFactIds: number[] | null;
  injectedFactIds: number[] | null;
  // content
  replyText: string | null;
  promptVariant: string | null;
  // diagnostics
  violationTags: string[];
  errorMessage: string | null;
  durationMs: number;
}

export interface ReplaySummary {
  generatedAt: number;                 // epoch seconds
  runnerVersion: string;               // const 'r6.3.0' — bump on schema change
  llmMode: 'mock' | 'real' | 'recorded';
  goldPath: string;
  benchmarkPath: string;
  totalRows: number;
  errorRows: number;
  silenceDeferCompliance: ComplianceMetric;
  violationCounts: Record<string, number>;    // key: ViolationTag string
  violationRates: Record<string, RateMetric>;
  resultKindDist: Record<ReplayResultKind, number>;
  utteranceActDist: Record<UtteranceAct, number>;
  guardPathDist: Record<string, number>;      // 'none' key for null
  reasonCodeDist: Record<string, number>;     // 'none' key for null
  actConfusion: Record<GoldAct, Record<UtteranceAct, number>>;
  perCategory: PerCategoryBreakdown[];
}

export interface ComplianceMetric {
  denominator: number;
  compliant: number;
  rate: number;        // 0..1, round to 4 decimals
}

export interface RateMetric {
  denominator: number;
  hits: number;
  rate: number;        // 0..1, round to 4 decimals; 0 when denominator === 0
}

export interface PerCategoryBreakdown {
  category: number;
  label: string;                 // from CATEGORY_LABELS at scripts/eval/categories/index.ts
  rowCount: number;
  silenceDeferCompliance: ComplianceMetric;
  violationCounts: Record<string, number>;
}

export interface ReplayerArgs {
  goldPath: string;
  benchmarkPath: string;
  outputDir: string;
  llmMode: 'mock' | 'real' | 'recorded';
  limit: number | null;          // null = no limit
  prodDbPath: string;            // source for tmp-copy; required
  botQQ: string;                 // required for bot-self-id wiring; from CLI
  groupIdForReplay: string;      // groupId context for ChatModule
  perSampleTimeoutMs: number;    // default 10_000
  randomSeed?: never;            // seeds intentionally unused — all determinism is hash-based
}

export { GoldAct, GoldDecision, GoldLabel, SampledRow, ChatResult };
```

### 2.1 Nullability rules (MUST enforce; match Designer §1.2)

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

**Wire invariant**: `JSON.stringify` MUST NEVER emit `undefined`. Use explicit `null`. Row-builder helper centralizes this (next section) so every code path produces the correct shape.

### 2.2 Row builder contract

```ts
// replay-runner-core.ts
export function buildReplayRow(args: {
  sampleId: string;
  category: number;
  gold: GoldLabel;
  triggerMessageId: string;
  result: ChatResult | { kind: 'error'; errorMessage: string };
  durationMs: number;
  violationTags: string[];
  utteranceAct: UtteranceAct;
}): ReplayRow {
  // Single source of truth for null-vs-value per result.kind.
  // Asserts nullability rules §2.1 via switch on result.kind.
  // Throws if caller passes a GoldLabel missing required fields (defense-in-depth).
}
```

All callers (runner core, unit tests) use `buildReplayRow`. No inline `{ ... }` object literals for `ReplayRow` elsewhere. This is the enforcement point for the nullability table.

---

## 3. No-Side-Effect Strategy (KEY DELIVERABLE from Task #3 brief)

Full enumeration of write paths inside `generateReply` and how each is stubbed.

### 3.1 Grep evidence: `src/modules/chat.ts` `generateReply` itself

Verified against file (read top-to-bottom, searched for write primitives):

| Concern | Evidence | Stub strategy |
|---|---|---|
| `adapter.send` / `sendGroupMessage` | **ZERO direct calls** inside `chat.ts`. Router (`src/core/router.ts:878`) sends after `generateReply` returns. | Replay runner **bypasses router entirely** — calls `chatModule.generateReply` directly. No adapter needed. |
| Raw SQL writes (`db.prepare(INSERT\|UPDATE\|DELETE)`, `db.exec`) | **ZERO occurrences** in chat.ts (grep `\.prepare\|\.run\|\.exec` ⇒ 0 matches). | No stub needed for chat.ts's own code path. |
| `db.<repo>.<write>` (insert/update/upsert/delete) on Database repos | **ZERO occurrences** inside `generateReply`'s call tree. All `this.db.*` usage in chat.ts is read-only: `getRecent`, `getRecentTexts`, `get`, `findBySourceId`, `searchByKeywords`, `listActive`, `listAliasFactsForMap`, `getByUser`, `getAdminsByGroup`, `getAll`, `getTopByGroup`. | No per-call stubs needed. Tmp-copy DB (§0 #2) absorbs any incidental write (MoodTracker.flush on destroy). |
| `ChatDecisionTracker.captureDecision` (writes `chat_decision_events` row) | Called from **router**, not chat.ts. Router not invoked in replay path. | No stub needed. |
| `expressionLearner`, `styleLearner`, `relationshipTracker`, `honestGapsTracker.recordMessage`, `honestGapsSource`, `selfLearning`, `aliasMiner`, `jargonMiner`, `phraseMiner`, `memeClusterer`, `diaryDistiller` (all writers) | Wired via `chat.set<X>Source/Tracker(instance)` in `src/index.ts:407-423`. ChatModule stores as private nullable. `generateReply` guards each read site with `if (this.<src>)` or `?.`. | **Do NOT call any `set<X>Source/Tracker` setter.** `selfLearning` option passed as `null` to ctor. All sources stay `null`. Writer path is physically unreachable. |
| `charModule` (read-heavy; has its own `learn` for persona patches) | Set via `setCharModule`. `chat.ts` calls `this.charModule?.<method>` — read-only reads on that path. | Leave `charModule` unset (null). Any char-mode samples in gold will fall through to default persona path. Documented as expected drift (see §9 Risks). |
| `MoodTracker` hydration in ctor: reads `db.mood`; `destroy()` flushes | Hydrates on construction (read). Flushes on `destroy()` — calls `db.mood.set(...)`. | Flush writes to tmp-copy DB, not prod. `destroy()` is idempotent → safe to call once after all rows processed. Tmp DB deleted on exit. |
| `setInterval` background timers (`moodProactiveTimer`, `deflectRefillTimer`) | Started in ctor when enabled flags true. | Pass `moodProactiveEnabled: false` + `deflectCacheEnabled: false` in `ChatOptions`. No timers created. |
| `conversationState.destroy()` in ChatModule.destroy | In-memory map cleanup only. | Safe; no-op effect. |
| In-memory Map mutations (`lastReplyToUser`, `botRecentOutputs`, `groupIdentityCache`, etc.) | Numerous inside `generateReply`. Process-local, no IO. | No stubbing needed. New ChatModule instance per runner invocation ⇒ fresh maps. |
| `this.claude.complete` (LLM) | 5 call sites inside chat.ts. Each expects `ClaudeResponse`. | `MockClaudeClient` returns deterministic `ClaudeResponse` per §4. |
| `this.visionService?.describe` / `this.embedder?.embed` | Null by default (options not passed). | Leave null ⇒ code paths skipped. |
| `this.localStickerRepo`, `this.bandoriLiveRepo` (read-only repos) | Optional; null by default. | Leave null. Sticker-first / bandori-live paths not exercised in replay. Documented drift. |

### 3.2 Construction recipe (inside `constructChatModule` in `replay-runner-core.ts`)

```ts
export function constructChatModule(args: {
  tmpDbPath: string;
  botQQ: string;
  mockClaude: IClaudeClient;
}): ChatModule {
  const db = new Database(args.tmpDbPath);   // reads schema, hydrates MoodTracker; writes go to tmp copy
  const chat = new ChatModule(args.mockClaude, db, {
    botUserId: args.botQQ,
    // R6.3: disable all background timers — runner manages lifecycle manually.
    moodProactiveEnabled: false,
    deflectCacheEnabled: false,
    // Leave all writer-facing options default (null/unset):
    //   selfLearning, embedder, visionService, localStickerRepo,
    //   bandoriLiveRepo, loreLoader, deflectionEngine, webLookup,
    //   imageDescriptions, forwardCache, stickerFirst.
    // Leave all CHAT options at default so retrieval/engagement behavior
    // in replay matches production as closely as possible.
  });
  // Do NOT call:
  //   chat.setExpressionSource / setStyleSource / setRelationshipSource
  //   chat.setHonestGapsSource / setHonestGapsTracker
  //   chat.setSelfLearning / chat.setCharModule
  //   chat.restoreBotRecentOutputs
  return chat;
}
```

### 3.3 Lifecycle (per-run)

```
1. fs.mkdirSync(outputDir, { recursive: true })
2. fs.mkdirSync(outputDir + '/.tmp', { recursive: true })
3. tmpDb = `${outputDir}/.tmp/replay-${process.pid}-${Date.now()}.db`
4. fs.copyFileSync(prodDbPath, tmpDb)
5. assert(tmpDb.includes('.tmp/replay-'))                    // defense
6. mockClaude = new MockClaudeClient()
7. chat = constructChatModule({ tmpDbPath: tmpDb, botQQ, mockClaude })
8. for each (goldRow, benchmarkRow):
     fixture = buildTriggerFromBenchmark(benchmarkRow, groupIdForReplay)
     try:
       result = await withTimeout(
         chat.generateReply(fixture.groupId, fixture.triggerMessage, fixture.recentMessages),
         perSampleTimeoutMs
       )
     catch (err): result = { kind: 'error', errorMessage: String(err) }
     utteranceAct = classifyUtterance(result, goldRow)
     tags = computeViolationTags(goldRow, projectedRow)
     row = buildReplayRow({ ... })
     writer.write(JSON.stringify(row) + '\n')
9. chat.destroy()                  // flush mood to tmp DB (NOT prod)
10. writer.close()
11. summary = aggregateSummary(rows)
12. fs.writeFileSync(outputDir + '/summary.json', JSON.stringify(summary, null, 2))
13. fs.rmSync(tmpDb)               // or .tmp/ wholesale; best-effort
14. process.exit(0)
```

### 3.4 Zero-side-effect **assertion** in tests

`replay-runner-mock.test.ts` MUST assert (per Planner acceptance):

1. Run replay against 2-row synthetic gold + 2-row synthetic benchmark.
2. Capture original mtime + sha256 of the prod DB file passed as `--prod-db`.
3. After runner exits: re-stat prod DB. Assert `mtime` and `sha256` unchanged.
4. Assert no file written under `data/` outside `data/eval/replay/`.
5. Assert `MockClaudeClient.callCount > 0` (at least one LLM call was exercised) AND `MockClaudeClient.realNetworkCalls === 0` (no escape hatch).

Deliverable: `assertNoProdContamination(prodDbPath, outputDir)` helper in `test/eval/helpers.ts`.

---

## 4. Mock LLM Interface — `scripts/eval/mock-llm.ts`

Implements `IClaudeClient` from `src/ai/claude.ts:52`. Three methods.

```ts
import { createHash } from 'node:crypto';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse, ClaudeModel } from '../../src/ai/claude.js';

export class MockClaudeClient implements IClaudeClient {
  callCount = 0;
  readonly calls: Array<{ model: string; systemChars: number; msgChars: number }> = [];
  readonly realNetworkCalls = 0;   // const 0 — tripwire for tests

  async complete(req: ClaudeRequest): Promise<ClaudeResponse> {
    this.callCount++;
    const systemText = req.system.map(b => b.text).join('\n');
    const messagesText = req.messages.map(m => `${m.role}:${m.content}`).join('\n');
    const fullPrompt = systemText + '\n' + messagesText;
    const hex8 = createHash('sha1').update(fullPrompt).digest('hex').slice(0, 8);
    this.calls.push({ model: String(req.model), systemChars: systemText.length, msgChars: messagesText.length });
    return {
      text: `[mock:${hex8}] 好的`,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  async describeImage(_imageBytes: Buffer, _model: ClaudeModel): Promise<string> {
    this.callCount++;
    return '[mock-image] 一张图片';
  }

  async visionWithPrompt(_imageBytes: Buffer, _model: ClaudeModel, prompt: string, _maxTokens?: number): Promise<string> {
    this.callCount++;
    const hex8 = createHash('sha1').update(prompt).digest('hex').slice(0, 8);
    return `[mock-vision:${hex8}] 看起来是一张图`;
  }
}
```

### 4.1 Determinism invariants

- Same `(system, messages)` ⇒ same `text`. Byte-identical across runs.
- `inputTokens`/`outputTokens` fixed at 0 so any usage-based branch in chat.ts takes the zero-tokens path.
- `[mock:` prefix is the sentinel — production Claude output never emits `[mock:`.
- SHA-1 (not SHA-256) matches Designer §3.1 keying choice.

### 4.2 Unit-test requirements (mock-llm.test.ts)

- Determinism: same req twice → same text.
- Distinct reqs → different hex8 (probabilistic but stable for fixed test inputs).
- `callCount` increments.
- `realNetworkCalls === 0`.
- Image paths return sentinel strings with correct prefix.

### 4.3 `--llm-mode=real` and `recorded`

Both stubbed:
```ts
if (args.llmMode === 'real' || args.llmMode === 'recorded') {
  console.error(`--llm-mode=${args.llmMode} not implemented in R6.3; use mock.`);
  process.exit(2);
}
```
Planner §Scope explicitly defers `recorded`; `real` is listed "opt-in" but Architect downgrades to throw-stub to remove blast radius in this PR. Documented in `docs/eval/replay-runner.md`. Adding it later is a one-liner: `mockClaude = new ClaudeClient()`.

---

## 5. Replay Fixture Construction — `scripts/eval/replay-fixture-builder.ts`

### 5.1 Input shape

The R6.1 benchmark is a `WeakLabeledRow` (= `SampledRow` + `label`) per line of `benchmark-weak-labeled.jsonl`. Relevant fields (from `scripts/eval/types.ts`):

```
SampledRow.id            = "${groupId}:${messageId}"    // sampleId — join key
SampledRow.groupId       = string
SampledRow.messageId     = number                       // messages.id (DB primary key)
SampledRow.sourceMessageId = string | null              // OneBot message_id string
SampledRow.userId        = string
SampledRow.nickname      = string
SampledRow.timestamp     = number                       // epoch seconds
SampledRow.content       = string                       // CQ-stripped
SampledRow.rawContent    = string | null                // with CQ codes
SampledRow.triggerContext       = ContextMessage[]      // 5 before, ASC
SampledRow.triggerContextAfter  = ContextMessage[]      // 3 after, ASC (unused in replay)
```

### 5.2 Target shape (`generateReply` signature)

From `src/modules/chat.ts:1539`:
```ts
generateReply(
  groupId: string,
  triggerMessage: GroupMessage,     // from src/adapter/napcat.ts:6
  recentMessages: GroupMessage[],
): Promise<ChatResult>
```

`GroupMessage`:
```ts
{
  messageId: string;      // OneBot string id
  groupId: string;
  userId: string;
  nickname: string;
  role: 'owner' | 'admin' | 'member';
  content: string;
  rawContent: string;
  timestamp: number;
}
```

### 5.3 Translation rules

```ts
export function buildTriggerFromBenchmark(
  row: SampledRow,
  groupIdForReplay: string,
): { groupId: string; triggerMessage: GroupMessage; recentMessages: GroupMessage[] } {
  const triggerMessage: GroupMessage = {
    messageId: row.sourceMessageId ?? String(row.messageId),   // prefer OneBot id; fallback to numeric id
    groupId: groupIdForReplay,
    userId: row.userId,
    nickname: row.nickname,
    role: 'member',                // R6.3: role not in benchmark; default 'member'. Documented drift.
    content: row.content,
    rawContent: row.rawContent ?? row.content,
    timestamp: row.timestamp,      // seconds, as GroupMessage expects (chat.ts:1565 * 1000 for ms conversions)
  };
  const recentMessages: GroupMessage[] = row.triggerContext.map(cm => ({
    messageId: String(cm.id),
    groupId: groupIdForReplay,
    userId: cm.userId,
    nickname: cm.nickname,
    role: 'member',
    content: cm.content,
    rawContent: cm.content,        // benchmark stores CQ-stripped only; acceptable for replay context
    timestamp: cm.timestamp,
  }));
  return { groupId: groupIdForReplay, triggerMessage, recentMessages };
}
```

### 5.4 Known fidelity gaps (drift; documented in `docs/eval/replay-runner.md`)

1. **Role defaulted to `'member'`** — benchmark does not carry `messages.role`. Admin/owner samples will mis-classify in role-sensitive gates. Impact: small — role-gated paths are rare and typically moderator-side.
2. **`recentMessages.rawContent = content`** — benchmark stores CQ-stripped `content` for context. Chat gates that inspect `rawContent` for CQ codes (e.g. `[CQ:at,qq=` detection on CONTEXT messages, not trigger) will miss matches. Trigger's `rawContent` is preserved correctly.
3. **No `triggerContextAfter` passed** — `generateReply` only takes pre-context (`recentMessages`). Aftermath is unused in replay by design.
4. **Scroll-back beyond 5 msgs unavailable** — benchmark window is 5; production sometimes reads up to `chatContextWide` (~20) via `db.messages.getRecent`. The tmp-copy DB DOES contain the real history, so when chat.ts calls `this.db.messages.getRecent(groupId, 20)` it will return production-truthful recent messages **provided `groupIdForReplay` matches the production group_id the benchmark was sampled from**. **Developer MUST pass `--group-id-for-replay` equal to the source group_id** (typically the 58w群聊 id used in R6.1 sampling). Validated in §7.

### 5.5 groupIdForReplay — required CLI arg

Non-negotiable. If omitted, runner exits 2 with explicit error. Default: `process.env.R6_3_REPLAY_GROUP_ID` if set; otherwise CLI-required.

---

## 6. Violation Tag Computation — `scripts/eval/violation-tags.ts`

### 6.1 Tag order

Tags are INDEPENDENT — no compound tag depends on another's boolean. All 10 evaluated in parallel, no short-circuiting. Order in `ALL_VIOLATION_TAGS` is the wire output order inside `row.violationTags[]`.

```ts
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

### 6.2 Dependencies between inputs

`computeViolationTags` takes the PROJECTED `ReplayRow`-shaped input (post-`utteranceAct` classification, post-`matchedFactIds` extraction). Caller order:

```
  1. generateReply → ChatResult
  2. classifyUtterance(result, gold) → utteranceAct
  3. project result into partial ReplayRow (matchedFactIds, resultKind, etc.)
  4. computeViolationTags(gold, partialRow)   ← THIS STEP — consumes classified inputs
  5. buildReplayRow(...)
```

`computeViolationTags` is PURE — no imports from `src/`, no I/O. Signature:

```ts
export function computeViolationTags(
  gold: GoldLabel,
  row: {
    category: number;
    resultKind: ReplayResultKind;
    utteranceAct: UtteranceAct;
    targetMsgId: string | null;
    matchedFactIds: number[] | null;
    replyText: string | null;
    // triggerMsgIdFromBenchmark: string — passed separately? No: baked into row.targetMsgId upstream.
  },
  triggerMessageId: string,           // the benchmark-side messageId for target-mismatch
): ViolationTag[];
```

### 6.3 Predicate table (FROZEN; mirrors Designer §4.1)

"Outputted" = `resultKind ∈ {reply, sticker, fallback}`. Silent/defer/error never count as outputted.

| Tag | Fires iff |
|---|---|
| `gold-silent-but-replied` | `gold.goldDecision === 'silent'` AND outputted |
| `gold-defer-but-replied` | `gold.goldDecision === 'defer'` AND outputted |
| `direct-at-silenced` | `row.category === 1` AND `row.resultKind === 'silent'` |
| `fact-needed-no-fact` | `gold.factNeeded === true` AND `row.resultKind === 'reply'` AND `(row.matchedFactIds?.length ?? 0) === 0` |
| `fact-not-needed-used-fact` | `gold.factNeeded === false` AND `row.resultKind === 'reply'` AND `(row.matchedFactIds?.length ?? 0) > 0` |
| `sticker-when-not-allowed` | `gold.allowSticker === false` AND `row.resultKind === 'sticker'` |
| `banter-when-not-allowed` | `gold.allowBanter === false` AND `row.resultKind === 'reply'` AND `matchesBanterRegex(row.replyText ?? '')` |
| `object-react-missed` | `gold.goldAct === 'object_react'` AND `row.resultKind === 'reply'` |
| `meta-status-misclassified` | `gold.goldAct === 'meta_admin_status'` AND `row.resultKind === 'reply'` AND `row.utteranceAct !== 'meta_admin_status'` |
| `target-mismatch` | outputted AND `row.targetMsgId != null` AND `row.targetMsgId !== ''` AND `row.targetMsgId !== triggerMessageId` |

### 6.4 Ambiguity resolutions (carried from Designer §4.2 — frozen)

(a) Gold self-conflicts: tags fire per predicate; `summarize-gold.ts` flags upstream.
(b) Fallback kinds count as outputted.
(c) Silent vs defer: `silent` is always compliant for both `gold-silent-but-replied` and `gold-defer-but-replied`. Defer is compliant for `gold-silent-but-replied` (Designer explicit).
(d) No per-row tag cap; `summary.violationCounts` is per-tag tally not per-row.

### 6.5 Denominator rules (for `summary.json.violationRates` — Designer §2.1)

```ts
export const DENOMINATOR_RULES: Record<ViolationTag, (gold: GoldLabel, row: ProjectedRow) => boolean> = {
  'gold-silent-but-replied':   (g) => g.goldDecision === 'silent',
  'gold-defer-but-replied':    (g) => g.goldDecision === 'defer',
  'direct-at-silenced':        (_g, r) => r.category === 1,
  'fact-needed-no-fact':       (g, r) => g.factNeeded === true && r.resultKind === 'reply',
  'fact-not-needed-used-fact': (g, r) => g.factNeeded === false && r.resultKind === 'reply',
  'sticker-when-not-allowed':  (g) => g.allowSticker === false,
  'banter-when-not-allowed':   (g, r) => g.allowBanter === false && r.resultKind === 'reply',
  'object-react-missed':       (g) => g.goldAct === 'object_react',
  'meta-status-misclassified': (g, r) => g.goldAct === 'meta_admin_status' && r.resultKind === 'reply',
  'target-mismatch':           (_g, r) => r.resultKind === 'reply' || r.resultKind === 'sticker' || r.resultKind === 'fallback',
};
```

Rows outside a tag's denominator do NOT contribute to `hits` even if predicate technically fires on a zero-denominator row (belt-and-braces; matches Designer).

### 6.6 Silence/defer compliance headline metric

```ts
silenceDeferCompliance = {
  denominator: rows.filter(r => GOLD_DEC_FOR(r.sampleId) ∈ {'silent', 'defer'} && r.resultKind !== 'error').length,
  compliant:   rows.filter(r => GOLD_DEC ∈ {'silent', 'defer'} && r.resultKind ∈ {'silent', 'defer'} && r.resultKind !== 'error').length,
  rate:        round4(compliant / denominator || 0),
};
```

Error rows EXCLUDED from both numerator and denominator (Designer §2.2). `errorRows` top-level tracks them separately.

---

## 7. CLI Contracts

### 7.1 `replay-runner.ts`

```
npx tsx scripts/eval/replay-runner.ts \
  --gold           data/eval/gold/gold-493.jsonl \
  --benchmark     data/eval/r6-1c/benchmark-weak-labeled.jsonl \
  --output-dir    data/eval/replay/smoke-baseline \
  --llm-mode      mock \
  --prod-db       bot.db \
  --bot-qq        <botQQ> \
  --group-id      <groupIdForReplay> \
  --limit         20          # optional; omit for full run
  --timeout-ms    10000       # optional; per-sample generateReply timeout (§0.Q5)
```

Exit codes:
- `0` — success, both output files written
- `1` — invalid args / gold or benchmark file missing / prod-db missing
- `2` — `--llm-mode=real|recorded` (not implemented) OR zero rows processed
- `3` — output write error OR zero-side-effect tripwire fired (prod DB modified — should be unreachable; fail loud if reached)

Stderr: one line per 20 samples processed: `processed 40/493 (err=0) compliance=0.6421`. Final line: full summary JSON stringified to stderr for shell-pipe friendliness.

### 7.2 `summarize-gold.ts` (R6.3.0)

```
npx tsx scripts/eval/summarize-gold.ts \
  --gold         data/eval/gold/gold-493.jsonl \
  --benchmark    data/eval/r6-1c/benchmark-weak-labeled.jsonl
```

Output — stderr only, structured in these sections (one blank line between):
```
=== Gold Act Distribution ===
direct_chat: 42
chime_in: 118
...
=== Gold Decision Distribution ===
reply: 180
silent: 95
defer: 23
=== Field Flag Counts ===
factNeeded: 67 / 493
allowBanter: 181 / 493
allowSticker: 61 / 493
=== Weak-vs-Gold Disagreement (expectedAct × goldAct) ===
               direct_chat  chime_in  ...
direct_chat    40           2         ...
...
=== Suspicious Rows ===
[goldAct=silence AND goldDecision=reply]      sampleId=123:4567
[goldDecision=silent AND allowSticker=true]   sampleId=123:4601
[factNeeded=true AND goldAct=object_react AND notes=empty] sampleId=...
[goldDecision=defer AND category=1]           sampleId=...
```

Exit code: `0` always (unless gold file missing → `1`). Non-blocking audit.

---

## 8. Test Contract

### 8.1 Unit tests (one file per module)

**violation-tags.test.ts** — REQUIRED per Planner acceptance:

Per tag (10 total), ≥1 positive case AND ≥1 negative case. Minimum 20 tests. Additionally:

- Empty gold / empty projected row → `[]`.
- Gold with multiple predicates firing simultaneously → all applicable tags in `violationTags`, in declaration order.
- Error-kind row → no tags fire (errorMessage is separate column).
- `targetMsgId == null` → `target-mismatch` does NOT fire.
- `targetMsgId === ''` (empty string, per PLAN defer edge case) → `target-mismatch` does NOT fire.
- `targetMsgId === triggerMessageId` → `target-mismatch` does NOT fire.
- `matchedFactIds = null` (silent result) → `fact-needed-no-fact` does NOT fire (denominator requires resultKind='reply').

**banter-regex.test.ts**:
- Each pattern: ≥1 positive example + ≥1 negative example.
- Edge cases: `哈` alone (no match), `哈哈哈哈哈哈` (matches `/哈哈/` AND `/(.)\1{3,}/`), `!!!` (matches), `!!` (no match), `草` alone (matches `/草+(?!泥)/`), `草泥马` (NO match), `233` (matches), `2333` (matches), port `:233/tcp` (matches — accepted FP per Designer §6.2).

**mock-llm.test.ts**:
- Determinism (same req → same text, twice).
- Hex8 is 8 lowercase hex chars.
- Different req → different hex (use two distinct prompts).
- `callCount` increments on each method.
- `realNetworkCalls === 0`.
- `describeImage` + `visionWithPrompt` return non-empty strings with correct prefixes.

**classify-utterance.test.ts**:
- Every `ChatResult.kind` branch returns expected `UtteranceAct`.
- `kind='sticker'` → `'object_react'`.
- `kind='fallback'` → `'unknown'`.
- `kind='silent'`, `'defer'` → `'none'`.
- `kind='reply'` with `text='禁言他'` → `'meta_admin_status'`.
- `kind='reply'` with `text='接 1'` → `'relay'`.
- `kind='reply'` with `text='我今天还没回'` → `'bot_status_query'`.
- `kind='reply'` with neutral text → `'unknown'`.

**replay-row.test.ts** (serialization):
- `JSON.stringify(buildReplayRow(...))` contains no `undefined` tokens.
- Every field of `ReplayRow` interface is present as a key in the output object (use `Object.keys` assertion against expected key list).
- Key ORDER matches interface declaration (stable diffs).
- Twice-serialized row is byte-identical (no date/random in row builder).

### 8.2 Integration test — `replay-runner-mock.test.ts`

Fixtures (committed):

- `test/fixtures/replay-gold-synthetic.jsonl` — 2 lines of `GoldLabel` (one `silent`, one `reply`).
- `test/fixtures/replay-benchmark-synthetic.jsonl` — 2 matching `SampledRow` lines.
- `test/fixtures/replay-prod-db-synthetic.sqlite` — minimal sqlite with bot schema + the 2 messages rows needed for context lookup. Built via a one-time script `scripts/eval/build-synthetic-replay-db.ts` (committed, deterministic); fixture regenerated by `npm run gen:replay-fixture` if schema drifts.

Test assertions:
1. Runner exits 0.
2. `replay-output.jsonl` has exactly 2 lines.
3. Each line JSON-parses. Each has all 20 keys of `ReplayRow`. None has `undefined` in stringified form.
4. `summary.json` exists, parses, has `silenceDeferCompliance.rate ∈ [0, 1]`.
5. **Zero side-effect**:
   - sha256 of synthetic prod DB unchanged before/after run.
   - mtime unchanged.
   - `mockClaude.callCount > 0`.
   - No files written outside `data/eval/replay/`.
6. Determinism: run twice in two tmp dirs; `replay-output.jsonl` byte-identical after normalizing `durationMs` field to `0`.
7. Missing benchmark row for gold sampleId → WARN line on stderr, row skipped (not in output), not crash. Achieved by deleting one benchmark row from a test copy.
8. `--limit 0` → exit 0, empty jsonl, zero-row summary.
9. Violation tag distribution non-degenerate (not all zero, not all firing).

Test suite harness: use vitest with `timeout: 30_000` per test. Run the runner as a child process via `execa` OR by importing `main()` from `replay-runner.ts` and calling it with parsed args. Prefer the importable-`main` path — faster, no subprocess overhead, coverage counted.

### 8.3 `summarize-gold.test.ts`

Synthetic fixtures with 5 rows each.

Assertions:
1. Exit 0.
2. stderr contains `'=== Gold Act Distribution ==='`.
3. stderr contains all 4 suspicious-row categories (emit at least one of each in fixture).
4. Stdout is empty (all output on stderr).

---

## 9. Architecture Health Assessment

### Clean

- Zero `src/` edits. DI via pre-existing `IClaudeClient` interface; all other sources nullable and already guarded.
- `computeViolationTags` and banter regex module are pure — no `src/` imports. Freezable as a standalone library.
- Tmp-copy DB isolates any incidental write and is removed on exit.
- No new npm dependency (`crypto`, `fs`, `path` all node built-in).
- `replay-runner-core.ts` separates CLI glue from logic → unit-testable without subprocess.

### Risks (non-blocking for R6.3)

1. **Tmp DB copy size**: bot.db is likely multi-GB on prod. Copy takes 30–120s wall-clock. Acceptable for a baseline tool; runner prints progress. Future: hard-link copy (`fs.linkSync`) — but SQLite WAL mutations through the copy's journal could bleed back. Stick with `copyFileSync` in R6.3 for safety.
2. **MoodTracker hydration reads full `mood` table on construct**. Depending on prod data, this is a several-MB read. One-shot, tolerable.
3. **charModule=null drift**: samples from char-mode groups will take the default persona path in replay. `summary.json.perCategory` will show distribution drift from prod for those samples. Expected; flagged in `docs/eval/replay-runner.md`.
4. **`recentMessages.rawContent` drift** (see §5.4 #2). Most gates read `triggerMessage.rawContent` not context; impact low.
5. **Role defaulted to `member`** (see §5.4 #1). Admin-gated paths drift. Impact low in R6.3 baseline use.
6. **Tmp DB not cleaned up if runner crashes hard (SIGKILL)**. Mitigate with `process.on('exit', cleanup)` best-effort hook.

### Missing test coverage — BLOCKER (must ship with implementation)

Per Planner acceptance:
- ✅ `test/eval/violation-tags.test.ts` ≥ 1 positive + ≥ 1 negative per tag (10 tags → 20+ tests).
- ✅ `test/eval/replay-runner-mock.test.ts` zero-side-effect assertion.
- ✅ `test/eval/summarize-gold.test.ts` exit 0 smoke.
- ✅ `test/eval/mock-llm.test.ts` determinism.
- ✅ `test/eval/classify-utterance.test.ts` each ChatResult.kind branch.
- ✅ `test/eval/banter-regex.test.ts` positive + negative per pattern.

If any of the above are absent at Reviewer time, Reviewer rejects.

---

## 10. Smoke Baseline Runbook (for Owner-Runner — R6.3.3)

### 10.1 Pre-flight (before R6.3.3 executes)

1. Confirm `data/eval/gold/gold-493.jsonl` exists and row count == 493.
2. Confirm `data/eval/r6-1c/benchmark-weak-labeled.jsonl` exists.
3. Confirm `bot.db` exists at path passed via `--prod-db`.
4. Confirm worktree is on `feat/r6-3-replay-runner` branch at HEAD with Dev's final commit merged locally.
5. Confirm `npm run test -- test/eval/` is GREEN before running the smoke.
6. Confirm `npx tsc --noEmit` is GREEN.

### 10.2 Command

```
cd D:/QQ-Group-Bot/.claude/worktrees/r6-3-replay
mkdir -p data/eval/replay/smoke-baseline

npx tsx scripts/eval/replay-runner.ts \
  --gold       data/eval/gold/gold-493.jsonl \
  --benchmark  data/eval/r6-1c/benchmark-weak-labeled.jsonl \
  --output-dir data/eval/replay/smoke-baseline \
  --llm-mode   mock \
  --prod-db    bot.db \
  --bot-qq     <botQQ> \
  --group-id   <groupId for replay; the group the benchmark was sampled from> \
  --limit      20 \
  --timeout-ms 10000
```

Expected wall-clock: <60s (Planner acceptance criterion).

### 10.3 Output verification

After completion, verify ALL:

1. Exit code `0`.
2. `data/eval/replay/smoke-baseline/replay-output.jsonl` exists; exactly 20 lines.
3. `data/eval/replay/smoke-baseline/summary.json` exists; valid JSON.
4. For every line in `replay-output.jsonl`:
   - `JSON.parse(line)` succeeds.
   - No field is the literal string `"undefined"`.
   - `resultKind` is one of `reply|sticker|fallback|silent|defer|error`.
   - `reasonCode` is string when `resultKind !== 'error'`, else `null`.
   - `utteranceAct` is one of the `UtteranceAct` enum values.
   - `usedFactHint` is boolean when `resultKind === 'reply'`, else `null`.
   - `matchedFactIds` is number[] when `resultKind === 'reply'`, else `null`.
   - `violationTags` is `string[]`, possibly empty.
5. `summary.json.silenceDeferCompliance.rate` is a number in `[0, 1]`.
6. `summary.json.errorRows` is low (expect `<= 1` on 20-row smoke; 0 is normal).
7. `summary.json.violationCounts` has ALL 10 tag keys (zero-filled if unseen).
8. Tag distribution non-degenerate: at least one tag >0 AND at least one tag ==0 (true sanity check against "all tags fire" and "no tags fire" bugs).
9. Verify tmp DB cleanup: `ls data/eval/replay/.tmp/` should be empty or absent.
10. **Critical zero-side-effect check**:
    ```
    sha256sum bot.db          # capture after run
    # Compare to sha256sum captured BEFORE the run (owner-runner takes both hashes).
    # MUST be identical. If not: exit 3 fail, open incident ticket, do NOT proceed.
    ```

### 10.4 Owner-runner reporting template

Post to team thread after smoke completes:

```
R6.3 smoke baseline verification
- Rows processed: 20/20
- Exit code: 0
- Wall-clock: <N>s
- silenceDeferCompliance.rate: <X.XXXX>
- Error rows: <N>
- Non-degenerate tag distribution: <YES/NO>
- bot.db sha256 unchanged: <YES/NO>
- replay-output.jsonl and summary.json attached (or commit hash)
```

### 10.5 Post-merge full baseline (NOT part of R6.3 PR)

After R6.3 merges to master, owner reruns WITHOUT `--limit 20` to produce `data/eval/replay/master-baseline/{replay-output.jsonl, summary.json}`. Gitignored; artifacts live locally only, passed around out-of-band or stored on bot's local filesystem.

---

## 11. Diff Budget & File Length

Per Task #3 brief: ≤400 lines per file, zero `src/` runtime edits.

Expected sizes (developer plans; reviewer flags deviations):

| File | Expected LOC | Over 400 OK? |
|---|---|---|
| `replay-types.ts` | ~100 | no |
| `mock-llm.ts` | ~60 | no |
| `classify-utterance.ts` | ~50 | no |
| `violation-tags.ts` | ~180 | no |
| `banter-regex.ts` | ~40 | no |
| `replay-fixture-builder.ts` | ~60 | no |
| `replay-runner-core.ts` | ~250 | no |
| `replay-runner.ts` | ~150 | no |
| `summarize-gold.ts` | ~200 | no |
| `replay-cli-args.ts` | ~80 | no |
| `docs/eval/replay-runner.md` | ~300 | no |
| `test/eval/violation-tags.test.ts` | ~350 | close — split if over |
| `test/eval/replay-runner-mock.test.ts` | ~250 | no |
| other tests | each ~100–150 | no |

If any file exceeds 400, Developer MUST split before submitting. `violation-tags.test.ts` is the one to watch — may need to split into `-basic.test.ts` + `-denominator.test.ts`.

---

## 12. Developer Handoff — Final Checklist

Before raising PR, Developer MUST verify:

- [ ] `npx tsc --noEmit` exits 0.
- [ ] `npm run test -- test/eval/` all green, no `.skip` or `.todo` committed.
- [ ] No file under `src/` is modified (`git diff --name-only origin/master -- src/` is empty).
- [ ] `scripts/eval/replay-runner.ts --llm-mode=mock --limit=2` works against synthetic fixture and exits 0.
- [ ] `data/eval/replay/` matches `.gitignore` additions; no replay JSONL/JSON accidentally committed.
- [ ] `docs/eval/replay-runner.md` documents: CLI usage, ReplayRow field reference (flat table, match §2.1 nullability), ReplaySummary field reference, violation tag list + conditions (match §6.3), known drifts from §5.4 and §9 risks.
- [ ] No `.claude/` contents staged.
- [ ] Commit message: `feat: R6.3 replay-runner infrastructure (evaluation only, zero src/ changes)`.

Reviewer gate unblocks on: all tests green + zero src/ diff + `assertNoProdContamination` passing + tag-per-unit-test coverage + smoke-baseline runbook runnable end-to-end against owner-runner's environment.

---

## 13. Unresolved — Punt to Dev/Runner

1. **`botQQ`**: pass as CLI `--bot-qq` arg. Do NOT hardcode. If importing from `src/config.ts` does not trigger side effects, Developer may choose that import; otherwise CLI arg is required.
2. **`groupIdForReplay`**: the 58w群聊 id used during R6.1 sampling. Owner-runner knows this value. Make it a required CLI arg — do not default.
3. **`durationMs` in regression test determinism**: tests normalize to `0` before comparing bytes; runner output keeps real `durationMs` for diagnostic use.
4. **Fixture DB schema regeneration**: if `src/storage/schema.sql` drifts post-merge, `scripts/eval/build-synthetic-replay-db.ts` regenerates `test/fixtures/replay-prod-db-synthetic.sqlite`. Add a CI check? Out of scope for R6.3 — manual step, documented in `docs/eval/replay-runner.md`.

Previously-unresolved items now settled in §0: Mock DB seeding (§0.Q3 — tmp-copy `node:sqlite`), per-sample wall-clock timeout (§0.Q5 — `Promise.race` + `setTimeout`, 10s default, `--timeout-ms` override).

---

*Sign-off: Architect — 2026-04-19 (initial) / 2026-04-20 (minimal-update). DEV-READY is authoritative. Conflicts with PLAN or DESIGN-NOTE are resolved HERE; earlier docs referenced for rationale only.*
