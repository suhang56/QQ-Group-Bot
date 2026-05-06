# Phase 1 PLAN — Wire `selfLearning` into replay-runner harness

**Branch**: `fix/replay-harness-wire-selflearning` (worktree
`D:/QQ-Group-Bot/.claude/worktrees/replay-harness-selflearning/`,
master `ae290a3`).

**Single-PR scope, single commit**:
`fix(eval): wire selfLearning into replay-runner harness — close fact retrieval silent-noop trap`

## 1. Why — second occurrence of the same trap shape

R9 retrieval audit `D:/QQ-Group-Bot/.claude/worktrees/r9-retrieval-audit/docs/eval/r9-retrieval-signal-audit-2026-05-05.md`
finds the R9.5 revival benchmark's `hasRealFactHit=0/781` is dominated
(~95%) by a **harness wiring bug**, structurally identical to the trap
PR #179 fixed for `ReplyPlanner`:

- `scripts/eval/replay-runner-core.ts:62-102` `constructChatModule` builds
  `ChatModule` with `{ botUserId, moodProactiveEnabled: false,
  deflectCacheEnabled: false }` only — no `selfLearning`, no `embedder`,
  no `loreLoader`, no `bandoriLiveRepo`.
- `src/modules/chat.ts:2882-2884` short-circuits via
  `(await this.selfLearning?.formatFactsForPrompt(...)) ?? { text: '',
  injectedFactIds: [], matchedFactIds: [], pinnedOnly: false }`. With
  `this.selfLearning === null`, **the entire fact-retrieval pipeline never
  runs** — no BM25, no vector, no Path A, not even pinned-newest fallback.
- Empirical signature: in 781 rows, every reply row has
  `injectedFactIds=[]` AND `matchedFactIds=[]`. Pinned-newest alone would
  always populate `injectedFactIds`; its emptiness is the smoking gun
  that `formatFactsForPrompt` never executes.

**This PR closes the `selfLearning === null` arm of that trap and adds a
permanent regression guard so a future refactor cannot regress.**

PR #179 precedent (commit `9e7428a`): added `replyPlanner` field to
`constructChatModule` return shape, gated on
`isReplyerLiteEnvOn()`, fail-open on construct error, plus
`test/scripts/eval/replay-harness-r9-wire.test.ts` (harness-level
T-1/T-2/T-2b) and `test/eval/replay-runner-r9-smoke.test.ts` (smoke-level
T-3/T-3b/T-3c). This PR mirrors that exact shape.

## 2. Scope — IN (verbatim from user lock)

1. Modify `scripts/eval/replay-runner-core.ts:62-102` `constructChatModule`:
   construct a `SelfLearningModule` from the `tmpDbPath` `Database` and
   the `mockClaude` client (mirroring `src/index.ts:239-243` production
   wiring), and pass it through to `new ChatModule(..., { ...,
   selfLearning })`. Embedder is a separate OPEN-Q (see §6 below) — the
   default for this PR is `embeddingService: null` so the semantic path
   degrades cleanly to BM25 + Path A (already supported by
   `formatFactsForPrompt` at `src/modules/self-learning.ts:423-424`).
2. Two regression tests:
   - **Harness-level** (mirrors PR #179 `replay-harness-r9-wire.test.ts`):
     assert that `constructChatModule` produces a `ChatModule` whose
     `selfLearning` field is non-null and is a `SelfLearningModule`
     instance.
   - **Smoke-level** (mirrors PR #179 `replay-runner-r9-smoke.test.ts`):
     end-to-end run on a minimal synthetic fixture seeded with one
     known-hittable fact (e.g. `topic='moegirl:高松灯'`,
     `fact='高松灯 = MyGO!!!!! 灯'`); trigger `'高松灯是谁'`; assert
     resulting replay row has `matchedFactIds.length > 0`.
3. Smoke replay `--limit ~10` against the prod-shaped fixture using a
   worktree-local script path (per
   `feedback_replay_runner_script_path_must_be_worktree_local`); confirm
   ≥1 row has `matchedFactIds` non-empty for an entity with prod-db
   facts.

## 3. Scope — OUT (verbatim from user lock)

- ANY retrieval coverage change (C-1 FTS5 phrase tokenizer, C-2
  Latin-leading mixed query, C-3 alias normalize, C-4 ad-hoc topics, C-5
  standalone-term mining — each is its own Phase 2 small PR).
- ANY R9 hydration / Planner prompt change.
- Any production flag flip.
- Other silently-null modules in `ChatModule` (audit notes `embedder`,
  `loreLoader`, `bandoriLiveRepo`, `webLookup`, `imageDescriptions`,
  `forwardCache`, `visionService`, `localStickerRepo`,
  `deflectionEngine`, `stickerFirst`, `forwardCache` are also
  unwired — but **this PR is scope-locked to `selfLearning` only**).
  Embedder is the only adjacent decision flagged as an OPEN-Q for
  Designer (§6), because `selfLearning` constructor takes
  `embeddingService` and the answer affects the constructor call shape.
- Re-running the full 781-row R9.5 revival benchmark — out of scope.
  Smoke run at `--limit ~10` is sufficient acceptance for this PR.
- Modifying any production code path. **Only `scripts/eval/` and
  `test/` files are touched.**
- Modifying `buildSyntheticReplayDb` to seed facts globally — see §5.

## 4. Files to touch

### Modified

- `scripts/eval/replay-runner-core.ts` — single function
  `constructChatModule` (lines 62-102).
  - Add imports: `SelfLearningModule` from
    `'../../src/modules/self-learning.js'`. (Logger import already
    present from PR #179.)
  - Inside `constructChatModule`, after the existing `db` open and
    BEFORE the `new ChatModule(...)` call, construct
    `selfLearning = new SelfLearningModule({ db, claude:
    args.mockClaude, botUserId: args.botQQ, embeddingService: null,
    researchEnabled: false, logger:
    createLogger('self-learning-replay') })`.
  - Pass `selfLearning` into the `ChatModule` ctor options object.
  - Wrap construct in `try/catch` and fail-open with
    `selfLearning = null` (precedent: PR #179 `replyPlanner`
    construction at `replay-runner-core.ts:88-98`). On catch, log
    warn but do NOT throw — preserves `feedback`-shape: harness must
    keep running so other tests still get coverage.
  - **Do NOT change** the `constructChatModule` return-tuple shape
    (still `{ chat, db, replyPlanner }`). The `selfLearning`
    instance is referenced only via `chat.selfLearning`
    (the harness-level test asserts on that field).

### New tests (mirror PR #179 layout)

- `test/scripts/eval/replay-harness-selflearning-wire.test.ts` —
  harness-level (T-1 / T-1b edge / T-1c edge).
  - **T-1**: `constructChatModule` returns a `chat` whose internal
    `selfLearning` field is a `SelfLearningModule` instance (cast
    via `(chat as unknown as { selfLearning: unknown }).selfLearning`
    — `SelfLearningModule` is private but the test only inspects
    instance-of). Designer phase decides whether to expose a thin
    public getter `chat.getSelfLearningForTest()` or rely on the cast
    (PR #179 used `result.replyPlanner` as a public return field;
    this PR keeps the return shape identical and inspects via cast).
  - **T-1b** (edge): `constructChatModule` with `mockClaude` whose
    `complete()` throws — `SelfLearningModule` constructor itself does
    NOT call `complete()`, so this is more about catching constructor
    throws if any are introduced later. Asserts harness still returns
    a non-null `chat`.
  - **T-1c** (edge): two consecutive `constructChatModule` calls do
    NOT share `selfLearning` state — each gets its own instance
    (regression guard against accidental module-level singleton
    introduction).

- `test/eval/replay-runner-selflearning-smoke.test.ts` — smoke-level
  (T-2 / T-2b / T-2c).
  - **T-2**: build a synthetic fixture with one fact row
    `topic='moegirl:高松灯'`,
    `fact='高松灯 = MyGO!!!!! 主唱'`, `groupId='958751334'`,
    confidence ≥ 0.8 (above `MIN_INJECT_CONFIDENCE`), no hedge
    markers; insert via `db.learnedFacts.insertOrSupersede(...)`.
    Inline gold/benchmark fixture with `content='高松灯是谁'`
    (matches Path A `deriveCjkTerm`); run `runReplay` at `--limit
    1`; assert resulting `replay-output.jsonl` has ≥1 row with
    `matchedFactIds.length > 0` AND that fact-id is in the row's
    `matchedFactIds` set.
  - **T-2b** (edge): same fixture but trigger content = `''` —
    `formatFactsForPrompt` early-returns at `triggerText.length === 0`
    via recency fallback path. Assert `matchedFactIds.length === 0`
    (recency populates `injectedFactIds` but NOT `matchedFactIds`),
    `pinnedOnly` semantics preserved.
  - **T-2c** (edge): fixture seeded with **zero** active facts;
    trigger `'高松灯是谁'`. Assert `matchedFactIds.length === 0` AND
    `injectedFactIds.length === 0` AND no crash. (Distinguishes
    "harness wired but DB empty" from "harness unwired" — the latter
    is the silent-noop trap this PR closes.)

## 5. Smoke fixture seeding strategy

The committed `test/fixtures/replay-prod-db-synthetic.sqlite` (built by
`scripts/eval/build-synthetic-replay-db.ts`) seeds **only two messages,
no facts**. Modifying it to seed facts globally is OUT OF SCOPE per user
lock — it is a shared fixture used by sibling tests (`replay-runner-mock.test.ts`,
`replay-runner-r9-smoke.test.ts`) that depend on the current shape.

**Decision**: smoke-level tests build their **own** synthetic fixture
inline, matching PR #179's pattern at
`test/eval/replay-runner-r9-smoke.test.ts:22` (dedicated fixture path
`test/fixtures/replay-prod-db-synthetic-r9smoke.sqlite`). For this PR:

- Dedicated fixture path
  `test/fixtures/replay-prod-db-synthetic-selflearning.sqlite` — built
  in `beforeAll` via `buildSyntheticReplayDb(...)` THEN
  `db.learnedFacts.insertOrSupersede(...)` to add the test fact.
- Filename contains `'synthetic'` so the
  `constructChatModule.includes('.tmp') || .includes('synthetic')`
  tripwire (line 67-71 of `replay-runner-core.ts`) is satisfied.
- Per-tmpdir copy at `beforeEach` (mirrors PR #179
  `makeTmpDb('t1')` pattern). Avoids `database is locked` race when
  vitest runs sibling test files in parallel forks.

**Choice of entity**: `'高松灯'` is the single best smoke entity per audit
table (replay-runner audit lines 91-103):

- Single-Han-token derivable: `deriveCjkTerm('高松灯是谁')` → `'高松灯'`
  (3-char run, passes `^\p{Script=Han}{2,10}$`).
- Topic-prefix `moegirl:高松灯` is in `LEARNED_FACT_TOPIC_PREFIXES`
  post-#149.
- Path A (`findActiveByTopicTerm`) hits cleanly without depending on
  BM25 (which has C-1 phrase-tokenizer issue) or vector (which would
  require running `EmbeddingService`).
- Audit confirms isolated repro: `findActiveByTopicTerm('958751334',
  '高松灯')` → 10 hits in prod-db.

`xtt` / `ygfn` / `羊宫妃那` are NOT viable smoke entities for this PR —
they hit C-2/C-3 misses (out of scope).

## 6. OPEN-Qs for Designer

These are flagged for Designer to lock a final answer in the DESIGN
phase. **Do not silently decide** — surface to team-lead if any answer
diverges from below.

### OQ-1 — Embedder: same PR or separate Phase 2 PR?

**Default proposed**: `embeddingService: null` for this PR.

- **Pro**: keeps PR strictly to user-locked `selfLearning-only` scope.
  `formatFactsForPrompt` already handles null-embedder by degrading to
  BM25-only at `self-learning.ts:423-424`. Smoke test entity
  (`高松灯`) hits via Path A which doesn't touch the embedder.
- **Con**: in real prod retrieval, embedder rescues C-1/C-2 misses via
  semantic. With null embedder, **harness BM25-only run** will
  systematically under-measure compared to prod for any entity that
  needed vector rescue.
- **Audit position** (line 244-246): "An embedder-null harness will
  measure BM25+Path A only, which is enough to differentiate A from
  C-1/C-2/C-3 in subsequent runs."
- **User lock**: "本 PR scope 锁紧 selfLearning-only. Designer 决定是否
  同 PR mirror or 等 Phase 2."

**Recommendation**: ship null embedder this PR. Phase 2 sub-PR
`fix(eval): wire embedder into replay-runner harness` adds embedder
when retrieval coverage PRs (C-1/C-2/C-3) need vector measurements.
Smoke entity `高松灯` does not require vector — Path A topic match is
sufficient acceptance.

### OQ-2 — `loreLoader` / `bandoriLiveRepo` / `webLookup` etc.: same PR?

**Default proposed**: NO. User lock explicitly rules out — "ChatModule
的其他 silently-null 模块... 但本 PR scope 锁紧 selfLearning."

Audit lists these as also-unwired in `constructChatModule`. They are
**not** in the same "fact retrieval" failure shape as `selfLearning`
(they affect `webLookupBlock`, `liveBlock`, lore-grounding, etc.).
Phase 2 small PRs each.

### OQ-3 — `botUserId: args.botQQ` — `selfLearning` accepts `string | undefined`

`SelfLearningOptions.botUserId` (self-learning.ts:41) is `string | undefined`.
`constructChatModule` arg `args.botQQ` is `string`. Pass directly. No
optionality conversion needed.

### OQ-4 — `researchEnabled: false`

Production wiring at `src/index.ts:241` reads `process.env['SELF_LEARN_ONLINE']
!== '0'` — i.e. defaults TRUE. **Harness must force FALSE** to
prevent any accidental online research call during replay. Default
`SelfLearningOptions.researchEnabled` is `true` at self-learning.ts:238
— so we MUST pass `researchEnabled: false` explicitly in harness.
Mirror discipline of `moodProactiveEnabled: false`,
`deflectCacheEnabled: false` already in harness.

### OQ-5 — Logger

Pass `logger: createLogger('self-learning-replay')` for log namespacing.
Same pattern as PR #179's `createLogger('reply-planner-replay')` at
`replay-runner-core.ts:90`.

### OQ-6 — `db.learnedFacts.setEmbeddingService(embedder)` step (line 255 of `index.ts`)

When embedder is null (OQ-1 default), this call is a no-op (the repo's
embedder service is what backs `listActiveWithEmbeddings`'s embedding
column read — but the column is itself BLOB-stored, not lazy-fetched).
**Skip in harness.** When OQ-1 is reversed in Phase 2, that PR adds
this line.

### OQ-7 — Harness assertion mechanism (instance-of vs public field)

PR #179 added `replyPlanner` to the **return tuple** for clean test
assertion: `result.replyPlanner instanceof ReplyPlanner`. This PR has
two options:

1. **Mirror PR #179**: extend return shape to `{ chat, db, replyPlanner,
   selfLearning }`. Test asserts on `result.selfLearning instanceof
   SelfLearningModule`. **Pro**: clean; consistent with #179 shape.
   **Con**: 4-field tuple may grow further (embedder, lore...) over
   time.
2. **Cast on chat instance**: keep `{ chat, db, replyPlanner }` shape;
   test casts `(chat as unknown as { selfLearning: unknown
   }).selfLearning`. **Pro**: keeps return shape stable. **Con**: cast
   smell; depends on `ChatModule.selfLearning` field staying
   non-private.

**Recommendation**: option 1 (extend return shape to include
`selfLearning`). Matches PR #179 precedent exactly. Designer may
override if there's a strong reason to keep the 3-tuple.

## 7. Acceptance criteria (verbatim)

- `tsc` clean — 0 errors. (Run `npx tsc --noEmit` from worktree root.)
- New regression tests pass: harness-level (T-1 / T-1b / T-1c) AND
  smoke-level (T-2 / T-2b / T-2c). All other existing tests in
  `test/scripts/eval/` and `test/eval/` continue to pass.
- Smoke replay `--limit ~10` (or smaller, e.g. `--limit 1` with
  inline fixture) shows ≥1 row with `matchedFactIds` non-empty for the
  smoke entity `高松灯`. Reviewer phase runs this end-to-end.
- ASCII single quotes only — no smart quotes (would break tsc).
- No emojis anywhere in code, tests, or commit message.
- No `Co-Authored-By` line in commit.
- No `.claude/` paths in commit (worktree internal docs stay
  local-only; only `scripts/eval/` and `test/` files in commit).
- Single commit:
  `fix(eval): wire selfLearning into replay-runner harness — close fact retrieval silent-noop trap`
- Conventional-commits format. Helpers normalize input internally.
  Validators at every boundary preserved.

## 8. Standing rules (verbatim)

- ASCII single quotes only — NO smart quotes.
- No emojis. No `Co-Authored-By`. No `.claude/` paths in commits.
- Edge tests mandatory (T-1b/T-1c/T-2b/T-2c above are the edge tests).
- Conventional commits.
- Helpers normalize input internally.
- Validator at every boundary.
- Bot is groupmate not assistant.
- Worktree-local script path discipline per
  `feedback_replay_runner_script_path_must_be_worktree_local` — smoke
  replay invocation in Reviewer phase MUST use the worktree path
  `D:/QQ-Group-Bot/.claude/worktrees/replay-harness-selflearning/scripts/eval/replay-runner.ts`,
  not the master-tree path.

## 9. Hand-off to Designer (Task #51)

Designer should:

1. Lock OQ-1 → OQ-7 (recommendations in §6 above).
2. Specify the exact `SelfLearningModule({...})` constructor call
   shape (after locking OQ-1/OQ-3/OQ-4/OQ-5).
3. Specify the exact ChatModule ctor object shape (full options object
   with new `selfLearning` field added — keep all existing fields
   including the R9 ReplyPlanner branch from PR #179 untouched).
4. Specify the exact return-tuple shape (option 1 vs option 2 from OQ-7).
5. Specify the exact smoke-fixture seeding code (one
   `db.learnedFacts.insertOrSupersede(...)` call after
   `buildSyntheticReplayDb(...)`).
6. Hand to Architect (Task #52) for verbatim diff plan.
