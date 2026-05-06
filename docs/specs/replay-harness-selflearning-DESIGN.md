# Phase 1 DESIGN — Wire `selfLearning` into replay-runner harness

**Branch**: `fix/replay-harness-wire-selflearning` (worktree
`D:/QQ-Group-Bot/.claude/worktrees/replay-harness-selflearning/`,
master `ae290a3`).

**Single-PR scope**:
`fix(eval): wire selfLearning into replay-runner harness — close fact retrieval silent-noop trap`

PLAN locked at `docs/specs/replay-harness-selflearning-PLAN.md`.
This DESIGN locks every OPEN-Q in PLAN §6 and pins the exact
constructor / return-tuple / fixture-seed / test-matrix shapes for
Architect → Developer.

---

## 0. Audit-vs-master sanity check

Pre-write reconciliation between PLAN cite-points and current master
`ae290a3` (post-#181):

- `scripts/eval/replay-runner-core.ts:62-102` — current state matches
  PLAN cite. `constructChatModule` returns
  `{ chat: ChatModule; db: Database; replyPlanner: IReplyPlanner | null }`.
  ReplyPlanner wire (PR #179) is at lines 87-99.
- `src/index.ts:239-243` — `SelfLearningModule` constructor call shape:
  `new SelfLearningModule({ db, claude, botUserId,
   researchEnabled: process.env['SELF_LEARN_ONLINE'] !== '0',
   embeddingService: embedder })`. Matches PLAN cite verbatim.
- `src/modules/self-learning.ts:225-241` — `SelfLearningModule`
  constructor reads from `SelfLearningOptions` (lines 36-64). All
  fields used by this DESIGN are present and unchanged.
- `src/modules/chat.ts:2882-2884` — short-circuit point matches PLAN
  cite verbatim. `selfLearning?.formatFactsForPrompt(...)` with `??`
  fallback to empty `FormattedFacts`.
- `src/modules/chat.ts:295` — `ChatOptions.selfLearning?:
  SelfLearningModule`. Optional. Field on `ChatModule` (line 1189) is
  `private readonly selfLearning: SelfLearningModule | null`.
- `LEARNED_FACT_TOPIC_PREFIXES` includes `'moegirl'`
  (`src/modules/fact-topic-prefixes.ts:16`); trust tier 3 path applied
  at line 93 (`topic.startsWith('moegirl:')`). Smoke entity choice
  validated.

**No conflict between PLAN cite and shipped master.** Proceeding.

---

## 1. OPEN-Q resolutions (verbatim lock)

### OQ-1 — Embedder: `embeddingService: null` for this PR. **PINNED.**

Audit endorsement (`r9-retrieval-signal-audit-2026-05-05.md` lines
244-246) confirms BM25+Path A measurement is sufficient to differentiate
A from C-1/C-2/C-3 in subsequent runs. Smoke entity `高松灯` resolves
through Path A `findActiveByTopicTerm` — does NOT touch embedder.
Phase 2 sub-PR `fix(eval): wire embedder into replay-runner harness`
adds embedder when retrieval coverage PRs need vector measurements.

### OQ-2 — Other silently-null modules: OUT OF SCOPE. **User-locked, no
override.**

### OQ-3 — `botUserId` source: pass `args.botQQ` through directly.
**PINNED.**

`SelfLearningOptions.botUserId: string | undefined`
(self-learning.ts:41). `constructChatModule` arg `args.botQQ: string`
(replay-runner-core.ts:64). No optionality conversion. No hardcoded
`'1705075399'`. No `args.bot` (no such field exists). Mirror prod
wiring at `src/index.ts:240` which passes `botUserId` (the same
string-typed variable) verbatim.

### OQ-4 — `researchEnabled: false` MANDATORY EXPLICIT. **PINNED.**

`SelfLearningOptions.researchEnabled` defaults to `true`
(self-learning.ts:238). Without explicit `false`, harness would
register research stamps (in-memory only, no live network call gated
behind separate `groundingProvider` setter — but we still want the
flag flipped for clarity and to suppress any future side-effects).
Mirrors discipline of `moodProactiveEnabled: false`,
`deflectCacheEnabled: false` already in `constructChatModule`.

### OQ-5 — Logger: pass `createLogger('self-learning-replay')`.
**PINNED.**

Mirrors PR #179 pattern at `replay-runner-core.ts:90`
(`createLogger('reply-planner-replay')`). `createLogger` already
imported at `replay-runner-core.ts:27`. No new import needed.

### OQ-6 — `db.learnedFacts.setEmbeddingService(embedder)`: SKIP.
**PINNED.**

When `embeddingService: null` (OQ-1), this call is a no-op. Repo
embedding column reads are BLOB-from-row, not lazy-fetch. Phase 2
sub-PR adds this line iff embedder is wired.

### OQ-7 — Return-tuple shape: **option 1 — extend tuple to
`{ chat, db, replyPlanner, selfLearning }`. PINNED.**

Rationale:

1. Mirrors PR #179 verbatim. Test asserts `result.selfLearning
   instanceof SelfLearningModule` cleanly (no cast smell).
2. `ChatModule.selfLearning` is `private readonly`
   (chat.ts:1189) — can't be inspected without `(chat as unknown as
   {...}).selfLearning` cast that violates encapsulation.
3. Tuple growth concern (option 2 con) is real but not urgent —
   Phase 2 may add `embedder`. We defer the discipline question
   ("dictionary form vs tuple form") to a future refactor PR;
   single-decision rule for now is "match PR #179".

**Locked return shape**:

```ts
{ chat: ChatModule; db: Database; replyPlanner: IReplyPlanner | null; selfLearning: SelfLearningModule | null }
```

`SelfLearningModule | null` (not non-null) because the construct is
wrapped in `try/catch` and fails open to `null` per PR #179
precedent. Existing replay-runner.ts call site
(`replay-runner.ts:298-302`) destructures `{ chat, db }` — non-named
fields are ignored, so this extension is backwards-compat without
a corresponding edit to `replay-runner.ts`. (Architect: confirm
during diff plan.)

---

## 2. Exact `SelfLearningModule` constructor call (Developer copy verbatim)

```ts
let selfLearning: SelfLearningModule | null = null;
try {
  selfLearning = new SelfLearningModule({
    db,
    claude: args.mockClaude,
    botUserId: args.botQQ,
    embeddingService: null,
    researchEnabled: false,
    logger: createLogger('self-learning-replay'),
  });
} catch (err) {
  createLogger('replay-runner-core').warn(
    { err: String(err) },
    'selfLearning not wired in harness — continuing without',
  );
  selfLearning = null;
}
```

Field-by-field justification:

| field | value | source |
|---|---|---|
| `db` | the `Database` opened from `args.tmpDbPath` | line 72 of replay-runner-core.ts (existing `db` local) |
| `claude` | `args.mockClaude` | OQ-3 — same client; `MockClaudeClient implements IClaudeClient`; mock-llm.ts:27 |
| `botUserId` | `args.botQQ` | OQ-3 |
| `embeddingService` | `null` | OQ-1 |
| `researchEnabled` | `false` | OQ-4 |
| `logger` | `createLogger('self-learning-replay')` | OQ-5 |

**Omitted fields** (defaults preserved):
- `correctionMaxPer10Min` / `correctionWindowMs` / `harvestMaxPerMinute`
  / `harvestWindowMs` / `model` / `now` / `researchMaxPer10MinPerGroup`
  / `researchMaxPerDayGlobal` / `groundingProvider`. Defaults at
  self-learning.ts:230-240. Harness behavior unaffected.

**Why mockClaude is reused (not a noop dummy)**: `SelfLearningModule`
constructor itself does NOT call `complete()`. The `claude` field is
used by `detectCorrection`, `harvestPassiveKnowledge`, and
`researchOnline` paths — none of which `formatFactsForPrompt` invokes.
`formatFactsForPrompt` (the one path the smoke fixture exercises)
reads `db.learnedFacts.findActiveByTopicTerm` + BM25 + recency only.
Reusing `mockClaude` keeps "one IClaudeClient per replay run"
discipline (PR #179 Designer Q1 precedent) without risk: any
unexpected `complete()` call routes through `MockClaudeClient` and
returns the deterministic `[mock:hex8]` body, never reaches network.

---

## 3. Exact `ChatModule` ctor call shape

The wire happens AFTER the `selfLearning` try/catch above and BEFORE
the existing R9 `ReplyPlanner` block (lines 87-99 of current
replay-runner-core.ts). Keep all existing ctor options unchanged; add
ONE field (`selfLearning`) to the options object:

```ts
const db = new Database(args.tmpDbPath);

// (selfLearning try/catch block from §2 inserted here)

const chat = new ChatModule(args.mockClaude, db, {
  botUserId: args.botQQ,
  moodProactiveEnabled: false,
  deflectCacheEnabled: false,
  selfLearning: selfLearning ?? undefined,  // null → undefined → ?? null in ChatModule
});
```

**Why `selfLearning ?? undefined`**: `ChatOptions.selfLearning` is
`SelfLearningModule | undefined` (chat.ts:295, optional). Internal
field assignment at chat.ts:1273 is
`this.selfLearning = options.selfLearning ?? null`. Passing `null`
directly would be a TS type error
(`Type 'null' is not assignable to type 'SelfLearningModule | undefined'`).
Coerce via `?? undefined` so the option-less and option-null arms
both resolve to `this.selfLearning === null`.

Existing R9 ReplyPlanner block (lines 87-99) stays UNTOUCHED. The
`chat.setReplyPlanner(replyPlanner)` post-construction wire still
runs after the `new ChatModule(...)` call, unaffected by the new
options field.

---

## 4. Exact return statement

```ts
return { chat, db, replyPlanner, selfLearning };
```

TypeScript signature update on the function declaration:

```ts
export function constructChatModule(args: {
  tmpDbPath: string;
  botQQ: string;
  mockClaude: IClaudeClient;
}): {
  chat: ChatModule;
  db: Database;
  replyPlanner: IReplyPlanner | null;
  selfLearning: SelfLearningModule | null;
}
```

New import at top of `replay-runner-core.ts`:

```ts
import { SelfLearningModule } from '../../src/modules/self-learning.js';
```

Place it adjacent to the existing `import { ReplyPlanner }` line
(line 25) for diff cleanliness.

---

## 5. Smoke fixture — dedicated path + seed code (verbatim copy)

### 5.1 Path

`test/fixtures/replay-prod-db-synthetic-selflearning.sqlite`

Filename contains `'synthetic'` to satisfy `constructChatModule`
tripwire (replay-runner-core.ts:67-71). Dedicated path (NOT the
shared `replay-prod-db-synthetic.sqlite`) prevents `database is
locked` race when vitest fork-pool runs sibling test files
(`replay-runner-mock.test.ts`,
`replay-runner-r9-smoke.test.ts`,
`replay-runner-r9-wire.test.ts`) in parallel —
each test file already owns a dedicated fixture path per PR #179
pattern.

### 5.2 Seed code (drop into smoke test `beforeAll`)

```ts
import { Database } from '../../src/storage/db.js';
import { buildSyntheticReplayDb } from '../../scripts/eval/build-synthetic-replay-db.js';

const FIXTURE_DB = path.join(REPO, 'test/fixtures/replay-prod-db-synthetic-selflearning.sqlite');

beforeAll(() => {
  buildSyntheticReplayDb(FIXTURE_DB);
  // Reopen to seed the smoke entity fact. buildSyntheticReplayDb
  // closes the db it opened (build-synthetic-replay-db.ts:68-70), so
  // we hold a fresh handle — no double-close risk.
  const db = new Database(FIXTURE_DB);
  db.learnedFacts.insertOrSupersede({
    groupId: '958751334',
    topic: 'moegirl:高松灯',
    fact: '高松灯 = MyGO!!!!! 主唱',
    canonicalForm: '高松灯',
    personaForm: null,
    sourceUserId: null,
    sourceUserNickname: 'moegirl-seed',
    sourceMsgId: null,
    botReplyId: null,
    confidence: 0.95,
    status: 'active',
  });
  try {
    (db as unknown as { rawDb?: { close?: () => void } }).rawDb?.close?.();
  } catch { /* ignore */ }
});
```

### 5.3 Field justification for the seeded fact

| field | value | rationale |
|---|---|---|
| `groupId` | `'958751334'` | Constant `GROUP_ID` per PR #179 smoke test (`replay-runner-r9-smoke.test.ts:16`) |
| `topic` | `'moegirl:高松灯'` | Path A topic match — `moegirl` prefix in `LEARNED_FACT_TOPIC_PREFIXES`, term `'高松灯'` passes `^\p{Script=Han}{2,10}$`. Audit prod-db sample has 10 rows of this exact shape. |
| `fact` | `'高松灯 = MyGO!!!!! 主唱'` | Real answer; not a hedge marker — passes `MIN_INJECT_CONFIDENCE` and `isHedged` checks at `_formatFactsRecency` filter. |
| `canonicalForm` | `'高松灯'` | Allows BM25 hit too (FTS index covers `canonical_form`); makes test less brittle. |
| `personaForm` | `null` | Unused in this path. |
| `sourceUserId` | `null` | `passive` shape — no user attribution needed for a seed. |
| `sourceUserNickname` | `'moegirl-seed'` | Diagnostic; identifies seed origin in logs. |
| `sourceMsgId` | `null` | No message provenance. |
| `botReplyId` | `null` | No bot reply reverse-link. |
| `confidence` | `0.95` | Above `MIN_INJECT_CONFIDENCE = 0.8` (self-learning.ts:175); above `>= 0.6` listActiveWithEmbeddings filter. |
| `status` | `'active'` | Default but explicit; protects against future default change. |

**T-2c (empty-DB) seed code variant**: skip the
`db.learnedFacts.insertOrSupersede` call entirely. Just
`buildSyntheticReplayDb(FIXTURE_DB)` — the synthetic builder seeds 2
messages but ZERO facts, which is exactly what T-2c needs.

---

## 6. Test matrix v2 — 6 first-class

### File: `test/scripts/eval/replay-harness-selflearning-wire.test.ts`
**Harness-level (T-1 / T-1b / T-1c)**

#### T-1: wire wires (basic)

**Setup**: `buildSyntheticReplayDb(FIXTURE_DB)` once in `beforeAll`.
Per-test `tmpDir` + `copyFileSync` to `tmp/synthetic.db` (mirror PR
#179 `makeTmpDb('t1')`).

**Mock**: vanilla `MockClaudeClient` (no patches).

**Action**:
```ts
const result = constructChatModule({
  tmpDbPath: tmpDb,
  botQQ: 'bot-test',
  mockClaude: new MockClaudeClient(),
});
```

**Assertions**:
- `result.chat` defined.
- `result.db` defined.
- `result.selfLearning` non-null.

#### T-1b: wired instance is a `SelfLearningModule`

**Setup**: same as T-1.

**Mock**: vanilla `MockClaudeClient`.

**Assertions**:
- `result.selfLearning instanceof SelfLearningModule`.
- (Reuse imports: `import { SelfLearningModule } from
  '../../../src/modules/self-learning.js'`.)

#### T-1c: fail-open on construct throw

**Setup**: same as T-1, but `mockClaude` is patched to throw if
constructor is wrapped — actually `SelfLearningModule` constructor
does NOT call `complete()`, so to force a throw we monkey-patch the
SelfLearningModule constructor itself (vitest's `vi.spyOn` on
constructor or import-mocking) OR pass a deliberately-broken `db`
arg.

**Realistic approach**: stub `Database` open to throw via passing
`tmpDbPath` that fails the tripwire — but the tripwire throws BEFORE
selfLearning construct, so that doesn't exercise the catch.

**Final approach**: use `vi.spyOn(SelfLearningModule.prototype,
'constructor' as any)` is not feasible (constructor isn't on
prototype). Instead, **vi.mock the import** with a constructor stub
that throws on `new`:

```ts
import { vi } from 'vitest';

vi.mock('../../../src/modules/self-learning.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/modules/self-learning.js')>(
    '../../../src/modules/self-learning.js',
  );
  return {
    ...actual,
    SelfLearningModule: class extends actual.SelfLearningModule {
      constructor(...args: ConstructorParameters<typeof actual.SelfLearningModule>) {
        if ((args[0] as { botUserId?: string }).botUserId === 'force-throw') {
          throw new Error('forced ctor throw for T-1c');
        }
        super(...args);
      }
    },
  };
});
```

**Action**: pass `botQQ: 'force-throw'`. Assert:

- `result.selfLearning === null` (fail-open default).
- `result.chat` defined (harness keeps running).
- `result.db` defined.

**Note for Architect**: vi.mock hoisting may interact with sibling
test files. **Alternative if vi.mock is fragile**: skip T-1c the
constructor-throw form and instead assert "wire is wrapped in
try/catch" via code review (Architect adds it as a manual review
checkbox in dev-ready). Designer recommends keeping T-1c as a
behavioral test — the vi.mock pattern is already used in QQ-Bot
test suite (search hits in `test/modules/`) and PR #179 didn't have
a fail-open test, leaving the fail-open arm uncovered. Closing that
gap here is worth the vi.mock complexity.

### File: `test/eval/replay-runner-selflearning-smoke.test.ts`
**Smoke-level (T-2 / T-2b / T-2c)**

#### T-2: wired + DB-has-fact + matching trigger → `matchedFactIds` populated

**Setup**: `beforeAll` runs `buildSyntheticReplayDb(FIXTURE_DB)` then
inserts the `高松灯` fact via `db.learnedFacts.insertOrSupersede`
(seed code §5.2). Inline JSONL fixture:

```ts
fs.writeFileSync(goldPath, JSON.stringify({
  sampleId: '958751334:9100',
  goldAct: 'direct_chat',
  goldDecision: 'reply',
  targetOk: true,
  factNeeded: true,
  allowBanter: true,
  allowSticker: false,
  labeledAt: '2026-05-05T00:00:00Z',
}) + '\n');
fs.writeFileSync(benchmarkPath, JSON.stringify({
  id: '958751334:9100',
  groupId: '958751334',
  messageId: 9100,
  sourceMessageId: 'src-9100',
  userId: 'U1100',
  nickname: '王五',
  timestamp: 1_713_001_000,
  content: '高松灯是谁',
  rawContent: `[CQ:at,qq=${BOT_QQ}] 高松灯是谁`,
  triggerContext: [],
  triggerContextAfter: [],
  category: 1,
  categoryLabel: 'direct_at_bot',
  samplingSeed: 1,
  contentHash: 'a3',
  contextHash: 'b3',
  label: {
    expectedAct: 'direct_chat',
    expectedDecision: 'reply',
    hasKnownFactTerm: true,
    knownFactSource: 'moegirl',
    hasRealFactHit: true,
    allowPluralYou: false,
    isObjectReact: false,
    isBotStatusContext: false,
    isBurst: false,
    isRelay: false,
    isDirect: true,
    riskFlags: [],
  },
}) + '\n');
```

CQ-at rawContent is REQUIRED to bypass timing-debounce silence per
PR #179 `replay-runner-r9-smoke.test.ts:30-37` doc comment.

**Mock**: vanilla `MockClaudeClient` (no Planner patch needed —
selfLearning's Path A doesn't invoke claude; the chat.ts main reply
LLM call returns the deterministic `[mock:hex8] 好的` body).

**Action**: `runReplay(args)` with `--limit 1`.

**Assertions**:
- `result.exitCode === 0`.
- `result.rowsWritten >= 1`.
- Parse `replay-output.jsonl`. At least one row has:
  - `resultKind === 'reply'` (CQ-at trigger; debounce passed; chat
    generates reply).
  - `matchedFactIds.length > 0`.
  - The seeded fact's id is in `matchedFactIds`. (Capture id from
    `db.learnedFacts.insertOrSupersede` return `newId` and pass into
    test scope.)
- `assertNoProdContamination(FIXTURE_DB, before)` — same prod-DB
  hygiene helper as PR #179 smoke (`test/eval/helpers.ts`).

#### T-2b: wired + DB-has-fact + non-fact trigger → `matchedFactIds === []`, `hasRealFactHit === false`

Same fixture as T-2 (DB has `高松灯` fact). Trigger content: `'随便聊聊'`.

**Mock**: vanilla MockClaudeClient.

**Action**: `runReplay(args)` with `--limit 1`. Same JSONL writing
as T-2 but `content='随便聊聊'`, `rawContent=
\`[CQ:at,qq=${BOT_QQ}] 随便聊聊\``.

**Assertions**:
- `result.exitCode === 0`.
- Parse output. At least one reply row has:
  - `matchedFactIds.length === 0` (no entity match — `'随便聊聊'`
    has no Han run that matches `高松灯` topic prefix; BM25 over
    `'随便聊聊'` against `canonical_form='高松灯'` returns 0).
  - This row's `injectedFactIds` MAY be non-empty (pinned-newest /
    recency populates with the `高松灯` row alone since it's the only
    active fact). Whether populated or not, the key signal is
    `matchedFactIds === []`.

**Why this distinguisher matters**: confirms `formatFactsForPrompt`
DID execute (selfLearning is wired) AND retrieved nothing (correctly
empty for non-fact trigger). The "wire wasn't reached" failure mode
would also produce `matchedFactIds === []` BUT also `injectedFactIds
=== []`. T-2b alone can't tell those apart — but T-2 already proves
non-empty matchedFactIds is achievable, so T-2b being empty
specifically on a non-fact query is a meaningful *negative*
assertion.

#### T-2c (CRITICAL DISTINGUISHER): wired + EMPTY DB + matching trigger → `matchedFactIds === []` AND `injectedFactIds === []`

**Setup**: dedicated `beforeAll` block in a *separate `describe`*,
or a sub-`beforeAll` that uses an alternate fixture path
`test/fixtures/replay-prod-db-synthetic-selflearning-empty.sqlite`
seeded by `buildSyntheticReplayDb(EMPTY_FIXTURE)` ONLY (no fact
insert).

**Mock**: vanilla MockClaudeClient.

**Action**: same trigger as T-2 (`'高松灯是谁'` with CQ-at).
`runReplay(args)` with `--limit 1`.

**Assertions**:
- `result.exitCode === 0`.
- At least one reply row has:
  - `matchedFactIds.length === 0` (DB has no facts; no retrieval can
    hit).
  - `injectedFactIds.length === 0` (DB has no facts; even
    pinned-newest has nothing to pin; recency fallback's `deduped`
    array is empty so `_formatFactsRecency` returns `injectedFactIds:
    []` per self-learning.ts:640).
- This is the **silent-noop trap fingerprint** — but here it's
  CORRECT (truly empty DB). The pre-fix harness produced this same
  fingerprint regardless of DB state. T-2 + T-2c together rule out
  the silent-noop regression: T-2 shows non-empty achievable, T-2c
  shows empty-when-truly-empty achievable, neither is the universal-
  empty pre-fix bug.

**Architect note**: T-2 + T-2c is the *minimum* pair to detect a
silent-noop regression. T-2 alone could pass with a wired-but-broken
retrieval; T-2c alone could pass with the unwired pre-fix code. Both
together require the harness to actually run retrieval against the
DB content — exactly what we want to lock in.

### Optional edges (NOT first-class — Architect may include or defer)

- **Fixture rebuild idempotence**: call `buildSyntheticReplayDb`
  twice in succession; assert second call doesn't throw. Already
  covered by build-synthetic-replay-db.ts:34-36 (rmSync on stale
  WAL). Skip.
- **Concurrent fixture access**: dedicated path discipline already
  prevents this (PR #179 lesson). Skip.
- **`_formatFactsRecency` `triggerText.length === 0` arm**: the
  smoke test path always passes a non-empty trigger; the empty-trigger
  arm is exercised by `self-learning.test.ts` unit tests (not in
  scope here). Skip.

---

## 7. Smoke replay verification command (Reviewer phase)

Worktree-local script path discipline per
`feedback_replay_runner_script_path_must_be_worktree_local`:

```bash
cd D:/QQ-Group-Bot/.claude/worktrees/replay-harness-selflearning
NODE_OPTIONS=--experimental-sqlite \
  npx tsx scripts/eval/replay-runner.ts \
    --gold test/fixtures/replay-bench-gold.jsonl \
    --benchmark test/fixtures/replay-benchmark-synthetic.jsonl \
    --output data/eval/replay/selflearning-smoke \
    --prod-db D:/QQ-Group-Bot/data/bot.db \
    --bot-qq 1705075399 \
    --group 958751334 \
    --limit 10 \
    --llm-mode mock
```

**Reviewer expected result**: `data/eval/replay/selflearning-smoke/replay-output.jsonl`
contains ≥1 reply row with `matchedFactIds.length > 0` for an entity
that prod-db has facts for. Audit page §"Per-entity sample" line
75-77 lists known-hittable entities: `高松灯` (10 rows), `拉神` (5
rows), `xtt` (1 row), `ygfn` (3 rows), `羊宫妃那` (5 rows). The
benchmark fixture `replay-benchmark-synthetic.jsonl` (committed
2-row fixture, build-synthetic seed) does NOT contain `高松灯` —
**Reviewer should use the actual R9.5 revival benchmark sub-set
that DOES contain trigger content with `高松灯` / `拉神` / etc., or
inline-write a 10-row benchmark JSONL that does**.

**Architect MUST clarify in DEV-READY**: Reviewer's smoke command
needs a benchmark file with at least one trigger that hits Path A
against prod-db. Two options:

A. **Use R9.5 revival benchmark slice**: `data/eval/benchmarks/r9-5-revival/...jsonl`
   exists per PLAN audit context. Reviewer slices `head -n 50` to
   find first 10 entries with trigger containing one of `高松灯 |
   拉神 | xtt | ygfn`.
B. **Inline-write a 10-row benchmark in the smoke command's
   `--benchmark` arg**: deterministic, no dependency on a moving
   benchmark file.

**DESIGN recommendation**: option B for Reviewer's runbook — fully
deterministic, doesn't depend on benchmark data evolving. Architect
specifies the inline JSONL content in DEV-READY.

**Acceptance** (Reviewer DONE gate):
- `replay-output.jsonl` line count ≥ 1.
- At least one row has `matchedFactIds.length > 0`.
- That row's trigger content includes one of the known-hittable
  entities.
- That row's `matchedFactIds[0]` resolves to a real prod-db
  `learned_facts.id` (via `sqlite3 data/bot.db "select id, fact
  from learned_facts where id = ${matched_id}"`).

---

## 8. Acceptance criteria (verbatim from PLAN, no modification)

- `tsc` clean — 0 errors. Run `npx tsc --noEmit` from worktree root.
- 6 regression tests pass (T-1 / T-1b / T-1c harness-level + T-2 /
  T-2b / T-2c smoke-level). All other existing tests in
  `test/scripts/eval/` and `test/eval/` continue to pass.
- Smoke replay `--limit ~10` shows ≥1 row with `matchedFactIds`
  non-empty for an entity with prod-db facts (Reviewer phase runs
  this end-to-end per §7 above).
- ASCII single quotes only — no smart quotes.
- No emojis anywhere in code, tests, or commit message.
- No `Co-Authored-By` line in commit.
- No `.claude/` paths in commit.
- Single commit:
  `fix(eval): wire selfLearning into replay-runner harness — close fact retrieval silent-noop trap`
- Conventional-commits format.
- Helpers normalize input internally.
- Validators at every boundary preserved.

---

## 9. Out of scope (verbatim from PLAN, no modification)

- C-1 / C-2 / C-3 / C-4 / C-5 retrieval coverage changes.
- R9 hydration / Planner prompt changes.
- Production flag flips.
- Embedder / loreLoader / bandoriLiveRepo / webLookup / etc. wires
  (all Phase 2 sub-PRs).
- Re-running the full 781-row R9.5 revival benchmark.
- Modifying `buildSyntheticReplayDb` to seed facts globally (shared
  fixture; out of scope per PLAN §5).
- Modifying any production code path (`scripts/eval/` and `test/`
  files only).

---

## 10. Standing rules (verbatim from PLAN — Developer briefing)

- ASCII single quotes only — NO smart quotes (would break tsc).
- No emojis. No `Co-Authored-By`. No `.claude/` paths in commits.
- Edge tests mandatory: T-1c (fail-open) AND T-2c (wired-but-empty-DB)
  are the SOUL edge tests.
- Conventional commits.
- Helpers normalize input internally.
- Validator at every boundary.
- Bot is groupmate not assistant.
- Metadata on result, no side-channel maps.
- Worktree-local script path discipline — Reviewer MUST run smoke
  command from worktree path, not master tree.

---

## 11. Hand-off to Architect (Task #52)

Architect should produce DEV-READY containing:

1. **Verbatim diff plan** for `scripts/eval/replay-runner-core.ts`:
   - New imports (line 25 area).
   - `selfLearning` try/catch block (between line 78 and the existing
     R9 ReplyPlanner block on line 87).
   - `selfLearning: selfLearning ?? undefined` field added to
     `ChatModule` ctor options object (line 73-77).
   - Return statement extended (line 101).
   - Function signature extended.

2. **Verbatim test file scaffolds** for the 6 tests, including:
   - Imports.
   - `beforeAll` / `beforeEach` / `afterEach` boilerplate.
   - JSONL fixture-writer helpers.
   - Per-test full assertion blocks.

3. **Reviewer runbook section**: option B inline benchmark JSONL
   verbatim (10 rows including a `高松灯是谁` trigger) for the smoke
   replay command.

4. **vi.mock decision for T-1c**: confirm pattern works with vitest
   fork-pool (cross-file pollution check) OR replace with
   import-mocking via a separate sub-file. Designer's recommendation
   is keep vi.mock; Architect free to switch if a sibling-file
   conflict is found.

5. **Pre-flight tsc check expectation**: enumerate the type assertions
   added by the new return field — `IReplyPlanner | null` and
   `SelfLearningModule | null` must propagate through any
   `replay-runner.ts` caller that destructures the result. Existing
   callsite at `replay-runner.ts:298-302` destructures only
   `{ chat, db }`; extension is backwards-compat. Architect verifies
   no other callsite of `constructChatModule` exists (search
   `scripts/eval/` + `test/` for the symbol).

After Architect signs off, hand to Developer (Task #53).
