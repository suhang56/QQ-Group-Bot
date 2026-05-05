# Replay-Runner Harness Fix — PLAN

**Branch**: `fix/replay-runner-r9-planner-wire`
**Worktree**: `.claude/worktrees/replay-harness-fix/`
**Master parent**: `6449849`
**Task**: #32 (Planner phase) → #33 Designer → #34 Architect → #35 Developer → #36 Reviewer
**Project plan ref**: `C:/Users/WaterMelon/.claude/plans/curried-wondering-rocket.md` line 175-181 (R9 multi-PR; this PR is infra-prep gating R9.4 re-baseline / task #37)

---

## 1. Problem Statement

### 1.1 Reviewer's diagnosis (saved 2026-05-05 in `.claude/code-reviews.md` R9.5 section)

The `scripts/eval/replay-runner.ts` benchmark harness instantiates `ChatModule` without ever wiring a `ReplyPlanner`. As a result, the R9 directive layer is unreachable from any benchmark run regardless of `R9_REPLYER_LITE_ENABLED` env value:

- `scripts/eval/replay-runner-core.ts:58-75` `constructChatModule(...)` builds `new ChatModule(args.mockClaude, db, { botUserId, moodProactiveEnabled: false, deflectCacheEnabled: false })` and returns. It NEVER calls `chat.setReplyPlanner(...)`.
- `src/index.ts:629-637` is the only call site of `setReplyPlanner` in the entire repo (production bootstrap, gated on `process.env['GEMINI_API_KEY']` + `R9_REPLYER_LITE_DISABLE_INSTANCE !== '1'`).
- `src/modules/chat.ts:1664` declares `private replyPlanner: IReplyPlanner | null = null;` as initial state.
- `src/modules/chat.ts:3161-3164` `r9ShouldRunPlanner = r9Enabled && !r9SkipForBotSelf && !r9SkipForScope && this.replyPlanner !== null`. The fourth conjunct `this.replyPlanner !== null` is always false in the harness, short-circuiting the entire R9 directive path.
- Every benchmark row therefore emits `plannerSource: 'no-planner-skipped'` (chat.ts:3177) and `fellBackReason: 'flag-off'`.

### 1.2 Why the +8 R9.4 "regression" is not real

The R9.4 benchmark documented `fact-needed-no-fact` going from 17 hits (master baseline) to 25 hits (R9-ON branch). With the harness unable to attach a `ReplyPlanner`, BOTH runs were effectively R9-OFF — both ran without an attached planner. The +8 delta is real-LLM Gemini stochastic re-roll variance, NOT R9 directive over-suppression of fact retrieval. The R9.5 PLAN §1.2-§1.3 smoking-gun diagnosis is consequently un-grounded by replay-runner data.

The R9.5 Planner-prompt addition (positive bullet for fact-no-hit + direct-question case) and the `getFactsByIds` + `factsByIdMap` hydration are still internally coherent and correct, and remain a needed prerequisite for R9.6 canary regardless of the R9.4 diagnosis. But the PRIMARY acceptance gate `fact-needed-no-fact ≤ 17` cannot be tested with the existing harness on master.

### 1.3 Scope of this PR

Repair the harness so the R9 directive layer becomes reachable when `R9_REPLYER_LITE_ENABLED=1` is set. Add regression-prevention tests so no future change can silently re-break the wire. This PR is infra-only — no chat behavior changes, no R9 prompt tuning, no benchmark re-baseline. Task #37 (R9.4 re-baseline) becomes runnable only after this PR merges.

---

## 2. Scope (per user direction)

### 2.1 In Scope

1. **Wire `ReplyPlanner` in `scripts/eval/replay-runner-core.ts:constructChatModule`**, mirroring `src/index.ts:629-637` production wiring. The wire must:
   - Be gated on the same `R9_REPLYER_LITE_ENABLED` env signal the chat module reads (via `src/config/reply-planner.ts:13-14 R9_REPLYER_LITE_ENV`), so flag-off remains byte-identical to current behavior.
   - Construct a `ReplyPlanner` with the SAME `IClaudeClient` instance the harness already passes in as `args.mockClaude` (the `RealClaudeClientForReplay` wrapper in real-LLM mode, or a mock in mock mode). NO separate Gemini client construction inside the harness — the harness has one LLM client per run, and `RealClaudeClientForReplay` already routes to Gemini OpenAI-compat when configured. This sidesteps the R9.5 review CRITICAL/MEDIUM finding about `CHAT_MODEL=gemini-2.5-flash` env divergence: the harness's existing client decision is the single source of truth.
   - Pass a logger (the existing `createLogger('reply-planner')` precedent from production, or a quiet `pino()`-equivalent for tests — Designer chooses).
   - Call `chat.setReplyPlanner(plannerInstance)` AFTER `new ChatModule(...)`, exactly as production does at `src/index.ts:633`.
   - Default-null arm preserves current callers when `R9_REPLYER_LITE_ENABLED !== '1'` — chat.ts:1664 initial state is reached, harness behavior identical to today.

2. **Harness-level防呆 test**: when `R9_REPLYER_LITE_ENABLED=1` is set during `constructChatModule`, assert the resulting `ChatModule` has a non-null `replyPlanner` field. This requires deciding access shape:
   - Option A: add a public getter `getReplyPlanner(): IReplyPlanner | null` to `ChatModule` (clean public API, ~3 LOC in `src/modules/chat.ts`).
   - Option B: assert via TypeScript-side bracket access (`(chat as { replyPlanner?: IReplyPlanner | null }).replyPlanner !== null`) without touching `chat.ts` at all. Less invasive but couples test to internal field name.
   - Option C: change `constructChatModule` to RETURN the planner instance alongside `chat` and `db`, so tests assert on the returned tuple. Most surgical to the harness contract; zero coupling to chat.ts internals.
   - **Designer call**. Default tilt is C (test asserts on what the harness returned, not on ChatModule internals); fall back to A if Designer finds wider downstream uses for the getter.

3. **Smoke-level防呆 test**: replay 1+ benchmark row through the actual harness with `R9_REPLYER_LITE_ENABLED=1` set and a deterministic mock LLM (NOT real Gemini); assert at least one output ReplayRow indicates the planner executed. Two surfacing strategies:
   - Strategy 1 (preferred): extend `ReplayRow` to carry `plannerSource: 'llm-planner' | 'rule-fallback' | 'no-planner-skipped' | null` from `result.meta.plannerSource` (already exists on `BaseResultMeta` per `src/utils/chat-result.ts:32`); test asserts `row.plannerSource !== 'no-planner-skipped'`. This is a one-field projection in `buildReplayRow` (`scripts/eval/replay-runner-core.ts:98`) plus a one-field addition to `ReplayRow` (`scripts/eval/replay-types.ts:28`). Permanent diagnostic value beyond the test.
   - Strategy 2 (fallback): test reaches into the `chat-decision-events` row written for the replay and asserts `planner_source` column. Heavier (DB query in test, requires the chat-decision-tracker to be wired in the harness). Avoid.
   - **Architect call**. Default tilt is Strategy 1 (additive ReplayRow field) since it's simpler AND gives the R9.4 re-baseline owner a permanent telemetry signal for future R9.x work.

### 2.2 Out of Scope (LOCKED)

- **R9.5 work**: continues on its own branch `feat/r9-5-tune` (worktree `.claude/worktrees/r9-5-tune/`). R9.5 task #31 stays `in_progress` until this PR merges + R9.5 benchmark re-runs through the fixed harness. No edits to R9.5 files in this PR.
- **R9.4 re-baseline**: deferred to task #37, runs only after this PR merges. No benchmark re-runs in this PR.
- **R9 Planner prompt tuning**: out — R9.5 owns prompt content.
- **Any `chat.ts` edit other than an OPTIONAL `getReplyPlanner()` getter** (Designer Option A, ~3 LOC). No edits to `r9ShouldRunPlanner` gate, no edits to hydration block, no changes to `setReplyPlanner` semantics.
- **`CHAT_MODEL` env handling fix** (R9.5 review MEDIUM finding): sidestepped by reusing `args.mockClaude` for the planner. The harness's existing client wins; no second model-name gate.
- **Gemini API key requirement**: in tests, mock LLM only. In real-LLM smoke (Reviewer), the existing `args.mockClaude = RealClaudeClientForReplay` already has the key.

### 2.3 Locked decisions

- The wire reuses `args.mockClaude` as the `IClaudeClient` for `ReplyPlanner` construction. ONE LLM client per harness run. This is the answer to "should the planner use Gemini Flash specifically?" — production does because `R9_PLANNER_MODEL` defaults to `gemini-2.5-flash`, but in the harness the client passed in already encapsulates that choice (real-mode wrapper or mock).
- Env-flag gating in the harness MIRRORS chat.ts: read `R9_REPLYER_LITE_ENV` from `src/config/reply-planner.ts:13`, NOT a fresh `process.env['R9_REPLYER_LITE_ENABLED']` read. Single source of truth for the flag.
- The wire is constructive (planner attached when flag on) AND default-null preserving (planner null when flag off). NEVER throws if `ReplyPlanner` import fails — try/catch + warn-log + null arm, mirroring `src/index.ts:634-636`. Fail-open semantics.

---

## 3. Files Touched (estimate)

| File | Change | LOC delta |
|---|---|---|
| `scripts/eval/replay-runner-core.ts` | wire `ReplyPlanner` construction inside `constructChatModule`; conditionally call `chat.setReplyPlanner(...)` gated on `R9_REPLYER_LITE_ENV`; possibly extend return shape per Designer Option C | +15 to +30 |
| `scripts/eval/replay-types.ts` | (Strategy 1) add `plannerSource: ... \| null` field to `ReplayRow` interface | +1 to +3 |
| `scripts/eval/replay-runner-core.ts` (cont.) | (Strategy 1) `buildReplayRow` projects `result.meta.plannerSource ?? null` for non-error kinds | +5 to +8 |
| `src/modules/chat.ts` | (Designer Option A only, conditional) public getter `getReplyPlanner(): IReplyPlanner \| null` | 0 OR +3 |
| `test/scripts/eval/replay-harness-r9-wire.test.ts` | new test file with T-1, T-2 (and optional T-2b) — harness-level wire assertions | +60 to +90 |
| `test/eval/replay-runner-r9-smoke.test.ts` OR extend `test/eval/replay-runner-mock.test.ts` | new T-3 (and optional T-4) — mock-LLM smoke through `runReplay` | +50 to +80 |

Estimated total: ~150-200 LOC across 3-5 files. Architect should keep `replay-runner-core.ts` ≤ 400 LoC budget (currently ~330 per R6.3 review header) — the +30 max here keeps it well within.

---

## 4. Test Matrix

### 4.1 First-class tests (mandatory; ≥3 per Iteration Contract)

| Test ID | Level | Setup | Assertion |
|---|---|---|---|
| **T-1** | harness-unit | `process.env['R9_REPLYER_LITE_ENABLED'] = '1'`; call `constructChatModule({ tmpDbPath, botQQ, mockClaude })` | Returned `chat` has `replyPlanner !== null` (Option A: via `chat.getReplyPlanner()`; Option B: via TS bracket access; Option C: via returned tuple). Reset env in afterEach. |
| **T-2** | harness-unit | `R9_REPLYER_LITE_ENABLED` UNSET (delete env key); call `constructChatModule({ ... })` | Returned `chat` has `replyPlanner === null`. Confirms default-null arm preserves opt-in semantics — preserves zero-impact-on-existing-harness invariant. |
| **T-3** | smoke-integration | `R9_REPLYER_LITE_ENABLED = '1'` + `runReplay(makeArgs(outDir))` against synthetic fixture (existing `test/fixtures/replay-prod-db-synthetic.sqlite`); mock LLM returns deterministic Planner-shaped JSON for the planner call AND a normal reply text for the chat call | Output `replay-output.jsonl` has at least one row where `plannerSource !== 'no-planner-skipped'` (Strategy 1: read `row.plannerSource` from JSONL; Strategy 2: query chat-decision-events table by replay group_id). |

### 4.2 Edge tests (mandatory per `feedback_edge_testing_soul`)

| Test ID | Level | Setup | Assertion |
|---|---|---|---|
| **T-2b (edge)** | harness-unit | `R9_REPLYER_LITE_ENABLED = ''` (empty string, not `'1'`); call `constructChatModule` | `replyPlanner === null`. Confirms env match is strict `=== '1'`, not truthy-coerce. Mirrors `src/config/reply-planner.ts:14`. |
| **T-3b (edge)** | smoke-integration | `R9_REPLYER_LITE_ENABLED` UNSET + same `runReplay` row | At least one row, every row has `plannerSource === 'no-planner-skipped'`. Proves the gate continues to skip when flag off (regression alarm if a future change leaks the wire). |
| **T-3c (edge)** | smoke-integration | `R9_REPLYER_LITE_ENABLED = '1'` + planner mock throws AbortError (timeout sim) | Row's `plannerSource === 'rule-fallback'`, NOT `'no-planner-skipped'` and NOT `'llm-planner'`. Proves the planner WAS reached and the rule-fallback branch fires. Validates the wire works end-to-end including failure path. |

T-2b, T-3b, T-3c are MANDATORY edge cases — Reviewer will reject for missing them.

### 4.3 Optional additional tests (Designer/Architect may add)

- T-4: `R9_REPLYER_LITE_ENABLED = '1'` + scope='direct-only' + non-direct trigger → `plannerSource === 'no-planner-skipped'` with `fellBackReason === 'scope-skipped'`. Proves chat.ts r9SkipForScope still gates.
- T-5: `R9_REPLYER_LITE_ENABLED = '1'` + bot-self trigger → `plannerSource === 'no-planner-skipped'` with `fellBackReason === 'bot-self'`. Proves chat.ts r9SkipForBotSelf still gates.

---

## 5. Acceptance Criteria

- [ ] `npx tsc --noEmit` — 0 errors
- [ ] All 3 first-class tests (T-1, T-2, T-3) pass
- [ ] All 3 mandatory edge tests (T-2b, T-3b, T-3c) pass
- [ ] Full `npm test` baseline-comparison: NO new regressions vs master `6449849`. Pre-existing failures (15 lore-retrieval missing fixture, 1 case-humanization comprehension boundary) acceptable. Reviewer captures both numbers.
- [ ] Reviewer runs SMALL real-LLM smoke (~5 rows, $0.50 USD cap, real-llm Gemini, `R9_REPLYER_LITE_ENABLED=1` AND `CHAT_MODEL=gemini-2.5-flash`). Asserts: ≥1 row has `plannerSource ∈ { 'llm-planner', 'rule-fallback' }`. Confirms wiring works through actual harness path, not just mock-driven unit tests.
- [ ] ASCII single-quotes only across all touched files; ZERO U+2018 / U+2019 / U+201C / U+201D
- [ ] No emojis in code, comments, commit, or test names
- [ ] No `Co-Authored-By` trailer in commit
- [ ] No `.claude/` paths anywhere in commit diff
- [ ] Conventional commit format
- [ ] Single commit on branch: `fix(eval): wire R9 ReplyPlanner into replay-runner harness + regression tests`
- [ ] Helpers normalize input internally (`feedback_normalize_inside_helper`) — wire helper inside `constructChatModule` reads env directly, not "caller passes flag"
- [ ] Validator at every boundary (`feedback_validator_at_every_boundary`) — `setReplyPlanner` already validates null|instance shape; harness reuses it without bypass

---

## 6. Out-of-band Notes for Pipeline Phases

### 6.1 For Designer (task #33)

Decide:
- **Q1**: Reply-planner construction shape — pass the same `IClaudeClient` (`args.mockClaude`) OR construct a separate `GeminiClient` like production does at `src/index.ts:632`?
  - Default tilt: reuse `args.mockClaude`. Keeps tests deterministic; sidesteps `CHAT_MODEL` env divergence; one LLM client per harness run is the established mental model.
- **Q2**: Test access shape — Option A (public getter on ChatModule), Option B (TS bracket access), or Option C (return planner alongside `chat`/`db` from `constructChatModule`)?
  - Default tilt: C. Most surgical, zero ChatModule public surface change, decouples test from chat.ts internals.
- **Q3**: How to surface `plannerSource` to `ReplayRow` — Strategy 1 (extend `ReplayRow` shape with `plannerSource` field) OR Strategy 2 (DB query in test)?
  - Default tilt: 1. One-field projection in `buildReplayRow`; permanent telemetry value for R9.4 re-baseline owner.
- **Q4**: Logger for `ReplyPlanner` in harness — `createLogger('reply-planner')` (production precedent) OR silent pino instance (test cleanliness)?
  - Default tilt: `createLogger('reply-planner')` for parity with production; tests can stub if log noise becomes annoying.

### 6.2 For Architect (task #34)

Produce the verbatim diff. Keep `replay-runner-core.ts` ≤ 400 LoC. Anchor every change to a Q-decision from §6.1 above. Specify env-restoration discipline in tests (afterEach restores prior `R9_REPLYER_LITE_ENABLED` value), NOT delete-only — concurrent test files may rely on it.

### 6.3 For Developer (task #35)

Implement verbatim per Architect's diff. ASCII quotes only — `feedback_no_smart_quotes`. Run `npx tsc --noEmit` + 6 new tests + full `npm test` before commit. Push to `origin/fix/replay-runner-r9-planner-wire`. Single commit.

### 6.4 For Reviewer (task #36)

Independent re-run of all gates. Run the SMALL real-LLM smoke ($0.50 USD cap, ~5 rows, env `R9_REPLYER_LITE_ENABLED=1` + `CHAT_MODEL=gemini-2.5-flash`) and confirm `plannerSource ∈ { 'llm-planner', 'rule-fallback' }` on at least one output row. Per `feedback_never_autonomous_merge_to_default_branch`, REVIEWER DOES NOT MERGE — APPROVED verdict + open PR + wait for user gate.

---

## 7. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `ReplyPlanner` import has top-level side effects that break tmp-DB harness | LOW | MED | try/catch + warn-log + null arm. Mirror src/index.ts:634-636. |
| Mock LLM returns the wrong shape for Planner JSON parse, every row hits `parse` fallback (silent T-3 false-green) | MED | MED | T-3c explicit-fallback test catches this. Designer specifies the mock's directive-JSON shape verbatim. |
| Some test infra elsewhere sets `R9_REPLYER_LITE_ENABLED=1` and leaks into other test files via env pollution | LOW | LOW | All new tests use `beforeEach` snapshot + `afterEach` restore. Same idiom as `test/eval/replay-runner-mock.test.ts`. |
| Adding `plannerSource` to `ReplayRow` breaks downstream summary aggregator | LOW | MED | Reviewer runs full `npm test`; `replay-summary.ts` aggregator is decoupled (it iterates known tag keys, not all fields). New optional field is additive. |
| Harness now reaches Gemini in real-LLM smoke even on rows that wouldn't have called it before (extra cost) | MED | LOW | $0.50 USD cap on Reviewer smoke; ~5 rows × 1 planner call ≈ $0.05 worst-case. Acceptable. |
| User adopts the wired harness for R9.4 re-baseline (task #37) and discovers the +8 was real after all | MED | LOW | Out of scope for this PR. Task #37 is the right place to surface that finding. R9.5 PR can then be retroactively re-justified or scope-reduced. |

---

## 8. Iteration Contract

Per `feedback_iteration_contract_needs_explicit_ack`: when each phase produces output, it sends `SendMessage team-lead "<Phase> DONE: <key picks>"` and waits for explicit "approved" before next phase starts. NOT "proceed unless objection".

When this PLAN is saved:
- Mark task #32 completed via TaskUpdate.
- SendMessage team-lead `"Harness Fix PLAN DONE: <key picks>"` per briefing instruction.
- Designer (#33) starts only after team-lead "approved".

---

## 9. Standing Rules Audit (verbatim, embedded per `feedback_embed_standing_rules_in_agent_briefing`)

- ASCII single quotes only — NO smart quotes (U+2018 / U+2019 / U+201C / U+201D)
- No emojis. No `Co-Authored-By`. No `.claude/` paths in commits.
- Edge tests mandatory (`feedback_edge_testing_soul`)
- Conventional commits (`feat`/`fix`/`refactor`/`docs`/`test`/`chore`: description)
- Helpers normalize input internally (`feedback_normalize_inside_helper`)
- Validator at every boundary (`feedback_validator_at_every_boundary`)
- Bot is groupmate not assistant (`feedback_groupmate_not_assistant_lens`) — N/A this PR (no bot-output behavior change)
- Trusted rules outside untrusted data (`feedback_trusted_rules_outside_untrusted_data_inside`) — N/A this PR (no LLM prompt edit)
- Reviewer does NOT merge to default branch (`feedback_never_autonomous_merge_to_default_branch`)
