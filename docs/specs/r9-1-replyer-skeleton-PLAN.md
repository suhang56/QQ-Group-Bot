# R9.1 — Replyer module skeleton + minimal contract — PLAN

> Phase 1 / Planner / 2026-05-05
> Worktree: `.claude/worktrees/r9-replyer-lite/` on `feat/r9-replyer-lite`
> Branch base: master `67f1a01` (rebased per briefing)
> Author: r9.1-planner. Project plan: `~/.claude/plans/curried-wondering-rocket.md` lines 175-181.
>
> Scope: this is the **first** of six R9 PRs (R9.1..R9.6). It ships a standalone
> Replyer (composer) module with a minimal contract. NO integration into chat.ts,
> NO feature flag, NO schema migration, NO benchmark. All of those are R9.2-6.

## §0 Project context (R9 multi-PR breakdown)

Per `~/.claude/plans/curried-wondering-rocket.md` lines 175-181 the R9 work is
split across six PRs. R9.1 (this PR) is FIRST in the order:

| PR    | Scope                                                           | Why before next                                            |
|-------|-----------------------------------------------------------------|------------------------------------------------------------|
| R9.1  | **Replyer module skeleton + minimal contract** (this PR)        | Locks the consumer interface so R9.2 Planner emits against a stable shape. No behavior change risk. |
| R9.2  | Planner module                                                  | Emits Directive into the R9.1 contract; standalone, untestable end-to-end without the consumer. |
| R9.3  | chat.ts wire-up + feature flag default OFF + DB migration       | Chains R9.1 + R9.2 behind flag; first behavior-touching PR. |
| R9.4  | Offline benchmark on R6 gold-1027 (must beat baseline)          | First quality gate; flag-on canary only after pass.        |
| R9.5  | Tune iteration                                                  | Address gaps surfaced by R9.4.                             |
| R9.6  | Real-group canary (group `958751334`, 48h)                      | Final ship gate; per PLAN edge D-8 baseline is byte-identical with flag off, so canary is safe. |

R9.1 is intentionally **decoupled** — the new module compiles, has tests, and
**is not yet imported anywhere in the running call graph**. That gives R9.2 and
R9.3 something to type-check against without R9.1 having to pass full
behavior-correctness review.

## §0.1 Branch state finding (surfaced to team-lead pre-write)

Branch HEAD before R9.1 write: `4258159 feat(reply): R9 reply-planner module —
Directive type, validator, fallback`. That commit was produced by the prior
R9-superset attempt (when R9 was scoped as one PR). It contains the **Planner
module** (`src/modules/reply-planner.ts`) — Directive type, validator,
fallback, ReplyPlanner class, PlannerContext, prompt assembly. The working
tree additionally has uncommitted changes to `chat.ts`, `db.ts`, `config.ts`,
`index.ts`, `chat-result.ts`, and a new `src/config/reply-planner.ts` (R9-superset
wiring residue).

**R9.1 takes Path A** — confirmed by team-lead 2026-05-05. Treat commit
`4258159` as if it were the future R9.2 PR landed early; R9.1 builds on top.
The project plan's R9.1/R9.2 ordering was a planning-time intent, not a
contract — what matters is the final state matches the multi-PR breakdown.
700 LOC of sound Planner code is too much to discard for ordering aesthetics.

Concrete consequences:

1. R9.1 imports the `Directive` type (and `assembleDirectiveBlock`,
   `LENGTH_BUDGET_CHAR_CAP`) from the existing `src/modules/reply-planner.ts`.
   Does NOT redefine. Single location, no aliasing
   (`feedback_no_deprecated_alias_on_clarifying_rename`).
2. The R9.1 PR diff contains ONLY new Replyer files —
   `src/modules/reply-composer.ts`, `test/modules/reply-composer.test.ts`,
   plus this PLAN doc and Designer/Architect output if added in same PR.
3. Uncommitted working-tree modifications to `chat.ts` / `db.ts` /
   `config.ts` / `index.ts` / `chat-result.ts` are reset via
   `git checkout HEAD -- <files>`. The untracked `src/config/reply-planner.ts`
   is removed. They all belong to R9.3.
4. `src/modules/reply-planner.ts` (the existing module on commit `4258159`)
   stays byte-identical. Reviewer verifies via
   `git diff master..feat/r9-replyer-lite -- src/modules/reply-planner.ts`
   showing zero changes attributable to R9.1 (the diff vs master will show
   the Planner commit's content; vs branch tip pre-R9.1 will show nothing).

## §0.2 R9.2 retro

After R9.1 ships, R9.2 (originally "planner module") becomes a retro-claim
of commit `4258159`. R9.2's PR may be:

- a **no-op / docs-only delta** if the existing Planner commit is complete
  and nothing was missed — R9.2 PR description simply documents that the
  Planner module landed early as part of the R9-superset attempt and the
  multi-PR breakdown now treats `4258159` as R9.2.
- a **tests-only patch** if Architect/Developer in the R9.2 cycle finds
  test gaps in the already-shipped Planner module (no behavior change,
  just additional first-class tests for any missing edge case from D-1..D-15
  not already covered by `test/modules/reply-planner.test.ts`).
- a **small refactor PR** if Architect finds a contract refinement needed
  to align the existing Planner with R9.3's wiring needs (e.g., expose a
  helper that's currently file-local).

R9.2 cycle Architect makes the call. R9.1 does NOT pre-decide R9.2's shape;
R9.1's only obligation is to leave commit `4258159`'s contents byte-identical.

## §1 Why R9.1 first

The single load-bearing reason: **R9.2 Planner must emit a Directive against
a stable consumer interface.** If the Replyer's contract isn't pinned first,
R9.2's "what does the Planner output for?" question is open and Designer/
Architect can't write a final spec.

Secondary reasons:
- **No behavior risk**: R9.1 ships a standalone module. Existing reply path
  (`chat.ts:1641-1680`) is untouched. No flag flip, no DB column, no rollout
  scary-list. R9.1 lands at master → CI green → no canary needed.
- **Test isolation**: R9.1 tests exercise the composer in isolation (mock
  IClaudeClient, fixture Directive, fixture ReplyContext). No integration test
  needed — R9.3 owns the integration test surface.
- **Reviewer scope is narrow**: R9.1 review is "is the contract right, does
  the prompt match DESIGN §2.2, do the validator-edges match D-* mapping?".
  No real-LLM benchmark, no metric scrape.

### Non-goal: R9.1 does NOT replace anything

R9.1 adds a NEW module. It does NOT modify the existing `chat.ts` reply path.
After R9.1 merges, the production reply path is **byte-identical** to before:
- `_generateReplyImpl` at `chat.ts:1682-3320+` unchanged.
- `chatRequest` factory at `chat.ts:3044-3069` unchanged.
- All existing post-LLM guards run unchanged.

## §2 Contract definition

### §2.1 The IReplyer interface (LOCKED)

File: `src/modules/reply-composer.ts` (new). Exports:

```ts
import type { Directive } from './reply-planner.js';

/**
 * Context the Replyer needs to compose a reply, beyond the Directive itself.
 * Independent of chat.ts internals so the Replyer is testable in isolation.
 *
 * INVARIANT: every field is supplied by the caller (chat.ts in R9.3) at the
 * call site. Helper normalizes input internally — caller passes raw values
 * (per feedback_normalize_inside_helper).
 */
export interface ReplyContext {
  /** QQ group id — used for log telemetry only; no per-group branching. */
  readonly groupId: string;
  /** Trigger message body, sanitized + length-capped by helper. */
  readonly triggerContent: string;
  /** Sanitized nickname of the trigger sender. */
  readonly triggerNickname: string;
  /**
   * Existing chat.ts system prompt blocks, in their existing order. R9.1
   * Replyer prepends its directive block to this array (cache: false slot
   * first, per DESIGN §2.1) and forwards the whole thing to chatRequest.
   * Caller is responsible for the existing v1/v2/STATIC blocks; R9.1 does
   * not re-derive them.
   */
  readonly systemBlocks: ReadonlyArray<{ readonly text: string; readonly cache: boolean }>;
  /** User-content payload for chatRequest. Caller assembles per existing chat.ts:3001-3004. */
  readonly userContent: string;
  /**
   * Lookup helper: matchedFactRetrievalIds → term/meaning. Used only by
   * `assembleDirectiveBlock` to render the must_use_facts lines.
   * Empty Map is a valid value when there are no facts.
   */
  readonly factsByIdMap: ReadonlyMap<number, { readonly term: string; readonly meaning: string }>;
  /** Chat model identifier — caller computes via existing _pickChatModel(). */
  readonly model: string;
  /** Max output tokens — caller passes existing chat.ts value (typically 600..1024). */
  readonly maxTokens: number;
}

/**
 * Output from a Replyer compose() call. Replyer is a pass-through to the
 * underlying LLM client; success returns text + token usage. Failures
 * propagate as ComposerError so the existing chat.ts retry/regen logic
 * decides whether to retry.
 */
export interface ComposeResult {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Echoed back from caller — used by chat.ts to attach to BaseResultMeta. */
  readonly directiveSnapshot: Directive;
  /** Soft-violation telemetry: directive said tiny, output went normal, etc. */
  readonly violations: ReadonlyArray<DirectiveViolation>;
}

/**
 * Soft violation — observability only in R9.1. Existing chat.ts post-LLM
 * guards still own all hard-veto behavior. R9.5 may add veto-and-regen
 * based on telemetry collected from these.
 */
export type DirectiveViolation =
  | { readonly kind: 'length-exceeded'; readonly cap: number; readonly actual: number }
  | { readonly kind: 'forbidden-token'; readonly token: string };

/**
 * Replyer (a.k.a. composer). One method: compose. Consumes a Directive +
 * ReplyContext and returns text. Always calls the underlying LLM exactly
 * once. Never modifies the Directive. Never veto-and-regens (R9.1 scope OUT).
 */
export interface IReplyer {
  compose(directive: Directive, ctx: ReplyContext): Promise<ComposeResult>;
}
```

Lockdown rationale:
- `Directive` is imported from `./reply-planner.js` (see §0.1 Path A). Single
  location, no aliasing per `feedback_no_deprecated_alias_on_clarifying_rename`.
- `ReplyContext` decouples Replyer from chat.ts internals — Replyer is testable
  with a fixture context, no chat.ts state graph required.
- `compose()` is a single entry point. No `composeWithRetry()`, no
  `composePipelined()`, etc. Add when telemetry justifies (R9.5+).
- Result is a NEW object (immutability rule); never mutates the Directive.
- Errors throw via the underlying client (ClaudeApiError / ClaudeParseError);
  the Replyer does NOT swallow. chat.ts integration in R9.3 owns retry policy.

### §2.2 The ReplyComposer class skeleton (LOCKED)

File: `src/modules/reply-composer.ts` (same file as §2.1). Class shape:

```ts
import type { IClaudeClient } from '../ai/claude.js';
import type { Logger } from 'pino';
import {
  assembleDirectiveBlock,    // already exported from reply-planner.ts (commit 4258159)
  LENGTH_BUDGET_CHAR_CAP,    // already exported from reply-planner.ts
  type Directive,
} from './reply-planner.js';

export interface ReplyComposerOptions {
  readonly logger?: Logger;
}

export class ReplyComposer implements IReplyer {
  constructor(
    private readonly llm: IClaudeClient,
    private readonly opts: ReplyComposerOptions = {},
  ) {}

  async compose(directive: Directive, ctx: ReplyContext): Promise<ComposeResult> {
    // 1. Validate input at boundary (per feedback_validator_at_every_boundary).
    //    Directive validator already ran upstream (Planner output / fallback).
    //    Here we re-check the few invariants the Replyer relies on:
    //    - Directive.mode !== 'silent' (silent should short-circuit BEFORE Replyer)
    //    - ReplyContext.systemBlocks is a non-empty array
    //    - ReplyContext.userContent is a non-empty string
    //    - ReplyContext.model is a non-empty string
    //    Throws ReplyerContractError on violation — these are programmer errors,
    //    not LLM errors, so they should fail loudly in tests/dev.
    this._validateInputs(directive, ctx);

    // 2. Assemble the directive block (delegated to existing helper —
    //    already locked per DESIGN §2.2). R9.1 does NOT re-derive prompt text.
    const directiveBlock = assembleDirectiveBlock(directive, ctx.factsByIdMap);

    // 3. Prepend directive block to systemBlocks (cache: false first slot).
    //    NEW array; never mutates ctx.systemBlocks.
    const systemBlocks = [
      { text: directiveBlock, cache: false as const },
      ...ctx.systemBlocks,
    ];

    // 4. Single LLM call via existing IClaudeClient interface — same chat
    //    model the caller picked. No model swap (per briefing "Replyer LLM =
    //    same as current chat LLM"). Same shape as chat.ts:3044-3069.
    const resp = await this.llm.complete({
      model: ctx.model,
      maxTokens: ctx.maxTokens,
      system: systemBlocks,
      messages: [{ role: 'user', content: ctx.userContent }],
    });

    // 5. Soft-violation observability (log only, NEVER veto in R9.1).
    //    Length check uses LENGTH_BUDGET_CHAR_CAP from reply-planner.ts.
    //    Forbidden-token check uses compact-whitespace normalization
    //    matching reply-planner's validateDirective (per
    //    feedback_cjk_compact_whitespace_match).
    const violations = this._scanViolations(directive, resp.text);
    if (violations.length > 0 && this.opts.logger !== undefined) {
      this.opts.logger.debug(
        { groupId: ctx.groupId, mode: directive.mode, violations },
        'reply-composer directive violations (observe-only)',
      );
    }

    // 6. Return immutable result — never mutates directive, ctx, or resp.
    return {
      text: resp.text,
      inputTokens: resp.inputTokens,
      outputTokens: resp.outputTokens,
      cacheReadTokens: resp.cacheReadTokens,
      cacheWriteTokens: resp.cacheWriteTokens,
      directiveSnapshot: directive,   // pass-through, not a clone — Directive is readonly
      violations,
    };
  }

  // Private helpers (kept on class; pure where possible).
  private _validateInputs(directive: Directive, ctx: ReplyContext): void { /* see §3.2 */ }
  private _scanViolations(directive: Directive, text: string): DirectiveViolation[] { /* see §3.3 */ }
}

/** Programmer-error class — distinct from LLM errors so tests can assert. */
export class ReplyerContractError extends Error {
  readonly code: 'silent-directive' | 'empty-system' | 'empty-user' | 'empty-model';
  constructor(code: ReplyerContractError['code'], message: string) {
    super(message);
    this.name = 'ReplyerContractError';
    this.code = code;
  }
}
```

Constraints:
- **No new prompt text in this PR.** `assembleDirectiveBlock` is already in
  `reply-planner.ts` (commit 4258159) and matches DESIGN §2.2 verbatim. R9.1
  re-uses it; does not re-implement.
- **No fallback Directive constructor** in `reply-composer.ts`. Caller (R9.3
  chat.ts) constructs the Directive (LLM or rule-fallback); composer treats
  it as an input.
- **No retry / no regen.** Single LLM call per `compose()`. R9.5+ may add
  veto-and-regen.
- **No DB writes.** `chat_decision_events.directive_json` persistence is R9.3.
- **No state.** Composer is stateless (a constructor argument is the LLM
  client; no per-call cache). Matches `pre-chat-judge.ts` / `style-learner.ts`
  modules in this codebase that hold no per-call state.

### §2.3 What is intentionally NOT in the contract

These belong to R9.2..R9.6:

- **Planner integration** — `compose()` does not invoke the Planner. R9.3 owns
  the "call Planner, then call Replyer" sequence.
- **Feature flag plumbing** — `compose()` runs unconditionally when called.
  R9.3 owns the gate at the call site (`isReplyerLiteEnabled(groupConfig)`).
- **Sticker-token resolution** — the existing `resolveStickerTokenOutput` at
  `chat.ts:3098` runs post-LLM in chat.ts, not in the Replyer. R9.1 does not
  touch sticker post-processing. The Replyer just forwards the directive's
  `sticker_hint` line in its prompt block.
- **Self-echo / scope-claim / sentinel guards** — all live in chat.ts. R9.1
  Replyer is a pure compose call. R9.3 wires those guards around the call.
- **Per-turn cooldown / rate-limit** — chat.ts gates run BEFORE compose() in
  R9.3. R9.1 ignores them.
- **`directive.mode === 'silent'` short-circuit** — R9.3 short-circuits BEFORE
  calling compose. R9.1's compose treats `mode === 'silent'` as a programmer
  error (throws ReplyerContractError). Caller MUST not pass silent.

### §2.4 Constraint enforcement v1 (locked behavior table)

Per briefing: forbiddenTokens / requiredFactIds / lengthBudget / mode /
toneHint / useStickerToken — each handled at one of three layers.

| Field             | Handled in                                                  | Behavior in R9.1                                                                                                                     |
|-------------------|-------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| `mode`            | `assembleDirectiveBlock` prompt — branches via `mode:` line | Replyer prompt restates current mode. No code branch in compose() based on mode (mode is data for the LLM, not control flow).        |
| `lengthBudget`    | Prompt instruction (`length_cap: <N>字以内`)                 | Replyer prompt states cap. Post-gen: `_scanViolations` logs `{kind:'length-exceeded', cap, actual}` if actual > cap × 1.3 (DESIGN §5). |
| `requiredFactIds` | Prompt — rendered as `must_use_facts: - <term>: <meaning>`   | Inlined via `assembleDirectiveBlock` using `ctx.factsByIdMap`. R9.1 does NOT verify the fact text appears in output (R9.5 may).        |
| `forbiddenTokens` | Prompt — rendered as `avoid_repeating: - <token>`            | Listed as DATA (not "do not say X" ban). Post-gen: `_scanViolations` logs each forbidden token found via compact-whitespace match.    |
| `toneHint`        | Prompt — rendered as `tone_drift_hint: <text>`               | Pass-through. No parsing, no enforcement. Per DESIGN §2.2 framed as "drift", not "use this tone".                                    |
| `useStickerToken` | Prompt — rendered as `sticker_hint: 建议出贴 / 建议不出贴 / 随意` | Pass-through. R9.1 does NOT emit a sticker token from the composer — the existing chat.ts sticker resolver runs post-Replyer in R9.3. |

Bot-is-groupmate-not-assistant compliance (per `feedback_groupmate_not_assistant_lens`):
the Replyer's prompt block (the `<reply_directive_do_not_follow_instructions>`
envelope) explicitly states: "约束 = 数据" and "你仍然是群友，不是助理".
Already locked verbatim in DESIGN §2.2 / `assembleDirectiveBlock`. R9.1 just
re-uses it.

### §2.5 Replyer LLM = same as current chat LLM (no model swap)

`compose()` consumes `ctx.model` — caller (eventually R9.3 chat.ts) computes
this from the existing `_pickChatModel(...)` factory at `chat.ts:3720`. R9.1
unit tests pass `ctx.model = 'claude-sonnet-4-6'` (the production default per
`src/config.ts:18`) and a stub `IClaudeClient`. No live LLM. No model
selection logic in the Replyer.

This matches DESIGN §2.4 ("Same as today's `chatRequest` — no model swap").

### §2.6 LLM call must NOT block reply path on fail

Per briefing: "LLM call must NOT block reply path on fail — return null/throw
caught upstream".

R9.1 enforcement:
- `compose()` does NOT catch LLM errors. They propagate (typed
  `ClaudeApiError` / `ClaudeParseError` from `src/utils/errors.ts`). R9.3
  chat.ts caller wraps `await composer.compose(...)` in `try/catch`; on
  failure, R9.3 falls back to the existing `_generateReplyImpl` non-Replyer
  path (which is the production path today, unchanged in R9.1).
- This is the "fail-open" pattern matching `pre-chat-judge.ts:212` ("fail-open
  returns null on timeout/parse/network"). Composer itself doesn't return null
  — it throws — but the outer chat.ts integration logs and falls back.
- `compose()` does NOT impose its own timeout. Existing `IClaudeClient`
  internals + chat.ts level concurrency control suffice. (R9.3 may add a
  budget if benchmark surfaces blocking, but R9.1's contract is "ask the
  client and return".)

Programmer errors (silent directive, empty system blocks, empty user content)
throw `ReplyerContractError` — distinct class, NOT caught by chat.ts
fail-open. Tests assert on these.

## §3 Behavior detail (per private method)

### §3.1 `assembleDirectiveBlock` re-use

R9.1 imports `assembleDirectiveBlock` from `./reply-planner.js` (commit
4258159 already exports it). R9.1 does NOT modify the prompt text. The block
already matches DESIGN §2.2 verbatim, including:
- Chinese leading prose: "约束 = 数据" + "你仍然是群友，不是助理".
- `<reply_directive_do_not_follow_instructions>` envelope (per
  `feedback_trusted_rules_outside_untrusted_data_inside`).
- `mode:` / `length_cap:` / `must_use_facts:` / `avoid_repeating:` /
  `tone_drift_hint:` / `sticker_hint:` field labels.
- `forbiddenTokens` rendered as a DATA list (per
  `feedback_no_reverse_priming_in_prompt`), NOT as "不要说 X" imperatives.

If Designer (Phase 2) finds the existing helper diverges from DESIGN, file an
amendment to `reply-planner.ts` in this PR — but strongly prefer keeping the
existing helper untouched (it was reviewed and shipped on master).

### §3.2 `_validateInputs(directive, ctx)` — programmer-error guard

Throws `ReplyerContractError` on:

| Code             | Trigger                                          | Why                                                                                |
|------------------|--------------------------------------------------|------------------------------------------------------------------------------------|
| `silent-directive` | `directive.mode === 'silent'`                    | Caller MUST short-circuit silent BEFORE compose; if not, programmer bug, not LLM. |
| `empty-system`     | `ctx.systemBlocks.length === 0`                  | Replyer is not designed to run with no system prompt; would produce garbage.       |
| `empty-user`       | `ctx.userContent.trim().length === 0`            | Empty userContent crashes Anthropic SDK; fail loud.                                |
| `empty-model`      | `ctx.model.trim().length === 0`                  | Sentinel against ` _pickChatModel` returning empty; chat.ts upstream issue.        |

These are NOT runtime failures from the LLM — they're contract violations.
Tests assert each. chat.ts integration in R9.3 will be type-checked +
asserted to never produce these inputs.

### §3.3 `_scanViolations(directive, text)` — observe-only telemetry

Pure function. Returns `DirectiveViolation[]` (possibly empty).

Scan A — length:
- `cap = LENGTH_BUDGET_CHAR_CAP[directive.lengthBudget]` (30 / 80 / 200).
- If `text.length > cap * 1.3` → push `{ kind: 'length-exceeded', cap, actual: text.length }`.
- 1.3× tolerance matches DESIGN §5 ("if `output.length > LENGTH_BUDGET_CHAR_CAP[directive.lengthBudget] * 1.3`").

Scan B — forbidden tokens:
- For each `tok` in `directive.forbiddenTokens`:
  - Apply compact-whitespace normalize to `text` (replace `\s+` with `''`).
  - Apply same to `tok` (already normalized in validateDirective; defensive double-apply is cheap).
  - If normalized text contains normalized tok → push `{ kind: 'forbidden-token', token: tok }`.
- Per `feedback_cjk_compact_whitespace_match` — compact, not collapseWs.

Scan C — required facts:
- **R9.1 SCOPE OUT**. Detecting fact presence in output requires NLI-grade
  matching (term may be paraphrased). R9.5 may add a hardened fact-presence
  scan based on telemetry. R9.1 just relies on the prompt instruction.

Scan output is logged at debug level only. R9.1 does NOT write to
`chat_decision_events`; R9.3 will plumb that.

### §3.4 No internal state

Composer is stateless. No cache, no in-memory log, no counter. All side
effects are: (a) the LLM call, (b) the optional debug log on violation.
This matches `pre-chat-judge.ts` (cache lives there, but compose-only modules
in this repo — `groupmate-voice.ts`, `style-learner.ts` — are stateless).

## §4 Test matrix (≥ 8 tests, all first-class per `feedback_edge_testing_soul`)

File: `test/modules/reply-composer.test.ts`. Vitest. Stub `IClaudeClient` via
plain object literal (no spy framework — matches existing
`reply-planner.test.ts` / `pre-chat-judge.test.ts` style).

### §4.1 Directive-shape validation cases (4)

| #   | Test                                              | Asserts                                                                                                  |
|-----|---------------------------------------------------|----------------------------------------------------------------------------------------------------------|
| T-1 | Directive `mode: 'silent'` → throws                | `await composer.compose(silentDirective, ctx)` rejects with `ReplyerContractError({code:'silent-directive'})`. LLM stub is NOT called. |
| T-2 | `ctx.systemBlocks` empty → throws                  | `ReplyerContractError({code:'empty-system'})`; LLM not called.                                           |
| T-3 | `ctx.userContent === ''` → throws                  | `ReplyerContractError({code:'empty-user'})`; LLM not called.                                             |
| T-4 | `ctx.model === '   '` (whitespace-only) → throws   | `ReplyerContractError({code:'empty-model'})`; LLM not called.                                            |

### §4.2 Prompt-assembly cases (3)

| #   | Test                                                            | Asserts                                                                                                            |
|-----|-----------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------|
| T-5 | Directive with `mode: 'fact_answer'` and `requiredFactIds: ['42']` (factsByIdMap maps `42` → `{term:'ras live', meaning:'11/15福冈'}`) → first system block contains `mode: fact_answer`, `must_use_facts:` line followed by `- ras live: 11/15福冈`. | Captures stub LLM's received `req.system[0].text`; substring asserts on Chinese envelope + must_use_facts line.    |
| T-6 | Directive with `forbiddenTokens: ['哈哈哈', '确实']` → first system block contains `avoid_repeating:` followed by `- 哈哈哈` and `- 确实`. | Substring assertions; verifies CJK passes through, no `[<>]` mangling.                                             |
| T-7 | Directive `useStickerToken: false` → first system block contains `sticker_hint: 建议不出贴`. Directive `useStickerToken: null` → contains `sticker_hint: 随意`. | Two sub-cases in one test (parametrized); asserts the BUDGET/STICKER label table from `assembleDirectiveBlock`. |

### §4.3 Length / forbidden-token soft-violation cases (2)

| #   | Test                                                                                                                          | Asserts                                                                                                                              |
|-----|-------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| T-8 | Directive `lengthBudget: 'tiny'` (cap 30); LLM stub returns 50-char text → `result.violations` contains `{kind:'length-exceeded', cap:30, actual:50}`. (50 > 30×1.3=39.) | One stub call; asserts on returned ComposeResult.violations array.                                                                   |
| T-9 | Directive `forbiddenTokens: ['哈哈哈']`; LLM stub returns `这事 哈 哈 哈 真的` (with whitespace inside the forbidden token) → `result.violations` contains `{kind:'forbidden-token', token:'哈哈哈'}` (matched after compact-whitespace normalize). | Asserts CJK compact-whitespace rule; per `feedback_cjk_compact_whitespace_match`.                                                    |

### §4.4 Pass-through happy path + immutability (2)

| #    | Test                                                                                                                       | Asserts                                                                                                                                  |
|------|----------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| T-10 | Stub LLM returns `{text:'就那场', inputTokens:100, outputTokens:5, cacheReadTokens:80, cacheWriteTokens:0}` → `result.text === '就那场'`, all token counts pass through. `result.violations` is empty array (not null). `result.directiveSnapshot === directive` (same reference). | Identity check on directive snapshot; no defensive copy needed because Directive is readonly all the way down.                            |
| T-11 | After compose returns, `ctx.systemBlocks` and `directive` are byte-identical to before compose (deep equality). Stub LLM was called with a system array of length `ctx.systemBlocks.length + 1`. | Asserts the immutability rule. Captures `[...ctx.systemBlocks]` and `JSON.stringify(directive)` before/after; asserts equal. Asserts stub received `req.system.length === origLen + 1` and `req.system[0].cache === false`. |

### §4.5 Error propagation (1)

| #    | Test                                                                                                | Asserts                                                                                                                  |
|------|-----------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------|
| T-12 | LLM stub throws `new ClaudeApiError('rate-limited')` → `compose()` re-throws SAME error (no swallow, no replacement). | `expect(() => composer.compose(...)).rejects.toBe(rateError)` (identity, not just instanceOf).                            |

### §4.6 Test count

12 first-class tests covering all field types in the directive shape, both
soft-violation kinds, immutability, error propagation, and the 4 contract
guards. Exceeds the "≥ 8" floor in the briefing. All map to a §2 contract
clause or a §3 method. No "future-feature" tests (e.g. retry-on-violation).

## §5 Out of scope (deferred)

Mirroring briefing's "Out of scope" exhaustively; each item names the PR that
will own it.

| OOS item                                                          | Lands in | Why deferred                                                                                            |
|-------------------------------------------------------------------|----------|---------------------------------------------------------------------------------------------------------|
| Planner module (Directive producer)                                | R9.2     | Already on branch as commit `4258159` (Path A). R9.2 may be docs-only or move/refactor.                 |
| chat.ts wiring (`_generateReplyImpl` calls Replyer)                | R9.3     | Behavior change; needs feature flag + canary plan.                                                      |
| Feature flag in `group_config` (`chat_planner_lite_v1`)            | R9.3     | Requires DB ALTER; depends on chat.ts wire-up to be meaningful.                                         |
| DB ALTER `chat_decision_events.directive_json` column              | R9.3     | Persistence path lives at `_persistDecisionEvent` in chat.ts.                                           |
| `schema.sql` updates for fresh installs                            | R9.3     | Same migration PR as the ALTER.                                                                         |
| Offline benchmark on R6 gold-1027                                  | R9.4     | First quality gate; must beat baseline before flag flip on canary group.                                |
| Tune iteration                                                     | R9.5     | Address gaps from R9.4 — possibly forbidden-token heuristic, possibly tone hint catalog, possibly veto. |
| Real-group canary (group `958751334`, 48h)                         | R9.6     | Final ship gate; enabled by R9.3's flag.                                                                |
| Veto-and-regen on directive violation                              | R9.5+    | Needs telemetry from R9.4 to justify cost.                                                              |
| Required-fact presence detection in output text                    | R9.5+    | Needs NLI-grade matcher; out of R9.1 cheap-helper scope.                                                |
| `BaseResultMeta` extension for `plannerSource` / `directiveMode`    | R9.3     | Wiring concern; meta is consumed by `chat-decision-tracker.ts`.                                         |
| Admin command to flip `chat_planner_lite_v1` per group             | R9.3     | Operational tooling; trivial mirror of layering-v2 admin command.                                       |
| Latency observability on `chat timing (planner)` log line          | R9.3     | Wiring concern.                                                                                         |
| `_pickChatModel` integration / hardened-path detection             | R9.3     | Caller-side concern; Replyer takes `ctx.model` opaquely.                                                |
| Sticker-token resolver post-Replyer interaction                    | R9.3     | `resolveStickerTokenOutput` already at `chat.ts:3098`, runs post-LLM in R9.3.                           |
| Cache placement (cache: false vs cache: true) of directive block    | (already locked) | DESIGN §2.1 already decided cache: false first slot. R9.1 honors it.                                    |

## §6 Acceptance for R9.1 PR

Identical to briefing; restated for completeness:

- [x] **tsc 0** — `npm run build` exits 0. New file compiles; existing files unchanged from commit `4258159`.
- [x] **New tests pass (≥ 8)** — 12 tests in `test/modules/reply-composer.test.ts` per §4.
- [x] **Full vitest no regression vs master `67f1a01`** — `npm test` shows the same 21 pre-existing failures as master (no new failures, no fixed-by-luck failures). Reviewer (Phase 5) records the master-vs-branch-vs-after-PR delta in `.claude/code-reviews.md`.
- [x] **ASCII single quotes only** — no smart quotes anywhere in new files. (CI `scripts/check-no-smart-quotes.sh` if present, otherwise grep clean per `feedback_no_smart_quotes`.)
- [x] **No emojis, no Co-Authored-By, no `.claude/` paths in commit** — per project hard rules + `feedback_no_claude_on_github`.
- [x] **Single commit** — message: `feat(reply): R9.1 replyer module skeleton + minimal contract`. Body briefly notes (a) what's in (Replyer + ComposeResult + IReplyer + violations + tests), (b) what's NOT in (no chat.ts wire, no flag, no DB).
- [x] **Working-tree reset before commit** — modifications to `chat.ts` / `db.ts` / `config.ts` / `index.ts` / `chat-result.ts` and the untracked `src/config/reply-planner.ts` are reset to match `4258159` before staging. ONLY new R9.1 files (`src/modules/reply-composer.ts` + `test/modules/reply-composer.test.ts` + `docs/specs/r9-1-replyer-skeleton-PLAN.md` + Designer/Architect output if added in same PR) land. (Per `feedback_user_coauthors_in_working_tree` — surface this to user before resetting if any uncommitted change is unrelated.)
- [x] **PR opened with `--base main --head feat/r9-replyer-lite`** explicitly per `feedback_gh_pr_create_explicit_base_head`.

Reviewer (R9.1 Phase 5) explicit asks:
- Re-run `npm run build` and `npm test` independently.
- Audit the new module against this PLAN's §2 contract section + §4 test matrix.
- Verify NO modifications to `chat.ts` / `db.ts` / `config.ts` / `schema.sql` / `index.ts` / `chat-result.ts` landed in the commit (`git diff master --stat` should list only new files).
- Verify the existing `reply-planner.ts` module is byte-identical to commit `4258159` (no incidental modification).
- Save review to `.claude/code-reviews.md` per `feedback_code_review_log`.

NO real-LLM benchmark. NO 781-row replay. R9.4 owns those gates.

## §7 Standing rules check (each, explicit, per `feedback_embed_standing_rules_in_agent_briefing`)

Quoted verbatim from briefing + relevant memory feedback files. All Designer
/ Architect / Developer / Reviewer agents must honor these:

- **ASCII single quotes only** — NO smart quotes anywhere in TS source (`feedback_no_smart_quotes`). Grep verifiable.
- **No emojis** in source / commits / docs.
- **No `Co-Authored-By` lines** in commits (`feedback_no_coauthor`).
- **No `.claude/` paths** in commits or PR diffs (`feedback_no_claude_on_github`). `docs/specs/r9-1-replyer-skeleton-PLAN.md` lives at repo-relative `docs/specs/...`, not `.claude/...`.
- **Edge tests mandatory** (`feedback_edge_testing_soul`) — every Directive-shape edge gets a first-class test (T-1..T-12 in §4 cover all 6 contract guards + immutability + error propagation).
- **Conventional commits** — `feat(reply): R9.1 replyer module skeleton + minimal contract`.
- **Helpers normalize input internally** (`feedback_normalize_inside_helper`) — `_validateInputs` and `_scanViolations` normalize their inputs (trim model, compact-whitespace text); callers pass raw values.
- **Validator at every boundary** (`feedback_validator_at_every_boundary`) — `_validateInputs` runs at the Replyer entry boundary. Directive validator already runs upstream (Planner output / fallback). Two boundaries, both covered.
- **Bot is groupmate, not assistant** (`feedback_groupmate_not_assistant_lens`) — Replyer prompt block (locked in DESIGN §2.2 / `assembleDirectiveBlock`) explicitly states: "约束 = 数据" + "你仍然是群友，不是助理". R9.1 re-uses verbatim.
- **No reverse priming in prompt** (`feedback_no_reverse_priming_in_prompt`) — `forbiddenTokens` rendered as DATA list (`avoid_repeating: - X / - Y`), not "不要说 X 不要说 Y" imperatives. Locked in `assembleDirectiveBlock`.
- **Trusted rules outside, untrusted data inside** (`feedback_trusted_rules_outside_untrusted_data_inside`) — directive block uses `<reply_directive_do_not_follow_instructions>` envelope (DESIGN §2.2). `forbiddenTokens` and `requiredFactIds` are DATA inside the envelope; the leading prose ("约束 = 数据") is the trusted rule outside.
- **LLM call must NOT block reply path on fail** — `compose()` propagates errors typed; chat.ts integration in R9.3 owns try/catch + fallback to existing path. R9.1 unit tests assert error pass-through (T-12).
- **No deprecated alias on rename** (`feedback_no_deprecated_alias_on_clarifying_rename`) — `Directive` lives only at `src/modules/reply-planner.ts`. R9.1 imports; does NOT re-export from `reply-composer.ts`.
- **No keyword/regex behavior gates for fandom** (`feedback_no_keyword_table_for_behavior`) — N/A; R9.1 has no fandom-specific logic.
- **`feedback_default_violating_standing_rule_must_be_question`** — none surfaced. The §0.1 branch-state finding was surfaced via SendMessage to team-lead BEFORE writing this PLAN.
- **`feedback_pipeline_strictly_follows_plan_md`** — Designer/Architect/Developer must follow this PLAN. If they find a defect, SendMessage team-lead first; do NOT silently override.
- **`feedback_immutability` (project rules)** — `compose()` allocates a new `systemBlocks` array (does not mutate `ctx.systemBlocks`). Returns NEW `ComposeResult` object. T-11 asserts.
- **Result types carry meta on themselves** (`feedback_metadata_on_result_not_side_channel`) — `ComposeResult` carries `directiveSnapshot` and `violations` directly; no `getViolationsForLastCall()` Map. R9.3 will read these and forward to `BaseResultMeta`.

## §8 Hand-off to Designer (R9.1 Phase 2, task #23)

Designer writes `docs/specs/r9-1-replyer-skeleton-DESIGN.md` (or appends a
section to the existing `r9-replyer-lite-DESIGN-NOTE.md`; recommend NEW file
to keep R9.1 scope-traceable, with cross-link to the superset DESIGN-NOTE
for shared Directive contract).

Designer covers:

1. **Final TypeScript shapes** for `ReplyContext`, `ComposeResult`,
   `DirectiveViolation`, `ReplyerContractError`. Lock field names; lock
   `readonly` modifiers.
2. **Confirm directive-block re-use is correct** — re-read DESIGN §2.2 and
   the existing `assembleDirectiveBlock` in `reply-planner.ts`; if they
   diverge, surface to team-lead before locking.
3. **Lock `_validateInputs` error code → message format** (Chinese? English?
   tests should assert on `.code`, not `.message`, so message can be any
   informative string).
4. **Lock `_scanViolations` length tolerance multiplier** — PLAN says 1.3
   (matches DESIGN §5). Designer confirms or proposes alternative with
   reasoning.
5. **Lock `factsByIdMap` numeric-id convention** — `matchedFactRetrievalIds`
   in chat.ts is `number[]`; Directive carries `string[]` (validator boundary
   converts). `factsByIdMap` keys are `number` — confirm this is the only
   `number` boundary the Replyer faces. (See DEV-READY §1A note about
   number-vs-string equality bugs at log/replay time.)
6. **Decide: should `compose()` accept a `signal: AbortSignal` for cancellation?**
   PLAN currently says no (caller-level cancellation). Designer may add if
   `IClaudeClient.complete` already supports it (it does NOT today per
   `src/ai/claude.ts:48-53` — no `signal` parameter). Recommend OUT for R9.1.
7. **Decide: logger injection** — PLAN puts `logger?` on `ReplyComposerOptions`.
   Designer may rename to required `Logger`, or use the module-level
   `createLogger('reply-composer')` precedent (`pre-chat-judge.ts:96`). Either
   is fine; lock and document.
8. **Edge cases not covered in §4** — Designer may add. Each new edge → new
   test row in §4 table (counts toward total).

Architect (R9.1 Phase 3, task #24) then writes the verbatim diff plan: file
name + EXACT line ranges + EXACT test cases. Developer (Phase 4) implements
+ commits + pushes. Reviewer (Phase 5) audits + APPROVED.

## §9 References

- `~/.claude/plans/curried-wondering-rocket.md:175-181` — R9 multi-PR breakdown.
- `docs/specs/r9-replyer-lite-PLAN.md` — R9-superset Planner output (DESIGN/scope/edge cases).
- `docs/specs/r9-replyer-lite-DESIGN-NOTE.md` — R9-superset Designer output (Directive shape, prompt block, fallback).
- `docs/specs/r9-replyer-lite-DEV-READY.md` — R9-superset Architect output (file diffs + line pins; superseded for R9.1 scope).
- `src/modules/reply-planner.ts` (commit `4258159`) — Existing module exporting Directive type, validator, fallback, ReplyPlanner class, `assembleDirectiveBlock`, `LENGTH_BUDGET_CHAR_CAP`. R9.1 imports from this file; does NOT modify it.
- `src/modules/pre-chat-judge.ts:99-220` — Module-shape precedent (constructor takes `IClaudeClient`, fail-open pattern, `Promise.race` + `AbortController`). R9.1 mirrors the constructor shape (sans cache) but does NOT mirror the fail-open — Replyer throws.
- `src/modules/groupmate-voice.ts` — Stateless compose-only module precedent (no cache, no per-call state).
- `src/ai/claude.ts:48-53` — `IClaudeClient.complete` signature R9.1 uses.
- `src/utils/errors.ts` — `ClaudeApiError` / `ClaudeParseError` propagated through compose().
- `src/config.ts:18` — `RUNTIME_CHAT_MODEL` default (`claude-sonnet-4-6`); test fixtures use this string.
