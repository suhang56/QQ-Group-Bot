# R9.1 — Replyer module skeleton + minimal contract — DESIGN

> Phase 2 / Designer / 2026-05-05
> Worktree: `.claude/worktrees/r9-replyer-lite/` on `feat/r9-replyer-lite`
> HEAD before R9.1 write: `4258159` (parent: master `67f1a01`)
> Author: r9.1-designer.
>
> Cross-links:
> - PLAN: `docs/specs/r9-1-replyer-skeleton-PLAN.md` (LOCKED upstream)
> - R9-superset DESIGN: `docs/specs/r9-replyer-lite-DESIGN-NOTE.md` (Directive shape lives here, locked)
> - R9-superset PLAN: `docs/specs/r9-replyer-lite-PLAN.md` (context)
>
> Scope: this is the **first** of six R9 PRs. R9.1 ships a standalone Replyer
> (composer) module with a minimal contract. NO chat.ts wire, NO feature flag,
> NO schema migration, NO benchmark. All deferred to R9.2..R9.6.

## §0 Hand-off resolutions (PLAN §8 items 1-8)

The PLAN handed eight open items to Designer. Each is resolved below with
a single locked decision; section refs point to the body text that pins it.

| # | PLAN §8 item                                 | Resolution                                                                                  | Pinned in |
|---|----------------------------------------------|---------------------------------------------------------------------------------------------|-----------|
| 1 | Final TS shapes                              | `ReplyContext` / `ComposeResult` / `DirectiveViolation` / `ReplyerContractError` — verbatim block in §1 | §1        |
| 2 | Error code -> message format                 | English message; tests assert `.code` only; message is dev-readable English (no Chinese)    | §1.4      |
| 3 | Length tolerance multiplier                  | **1.3** (matches PLAN §2.4 + R9-superset DESIGN §5; reasoning in §3.2)                      | §3.2      |
| 4 | factsByIdMap numeric-id convention            | Keys are **`number`**. `requiredFactIds` is `string[]`. Renderer (`assembleDirectiveBlock`) does `Number(idStr)` once at lookup. R9.1 inherits this from existing helper at `reply-planner.ts:404-426`; does NOT re-introduce drift. | §1.2      |
| 5 | AbortSignal on `compose()`                   | **OUT for R9.1.** `IClaudeClient.complete` does not accept a signal today (`src/ai/claude.ts:52-58`). Adding one to the Replyer contract while the underlying client cannot honor it would mislead callers. Re-evaluate in R9.5+ if SDK gains support. | §2.3      |
| 6 | Logger injection style                       | Constructor-injected via `ReplyComposerOptions.logger?: Logger`. Optional; when absent, observability is silent. **Rationale**: matches the existing `ReplyPlanner` constructor at `reply-planner.ts:587-602` which already takes `Logger` as a constructor arg. Keeps test ergonomics (no module-level singleton state to reset). NOT module-level singleton like `pre-chat-judge.ts:100`. | §2.4      |
| 7 | Edge case extensions beyond Planner's 12     | Add T-13 `useStickerToken: true` happy path (PLAN T-7 only covers `false` + `null`). Final test count = **13**. | §4        |
| 8 | Items Planner deferred                       | Required-fact presence detection (`Scan C` in PLAN §3.3) — confirmed OUT for R9.1. Persistence (`directive_json` write) — confirmed OUT for R9.1. `BaseResultMeta` extension — confirmed OUT for R9.1 (lands in R9.3 wiring). Each carried in §5. | §5        |

No tension surfaced between R9.1 PLAN and R9-superset DESIGN-NOTE that
required SendMessage callback. The Directive shape, prompt block, and
`assembleDirectiveBlock` helper at HEAD `4258159` match DESIGN-NOTE §1
and §2.2 verbatim — Designer re-read both before locking §1.

## §1 TypeScript shapes (FINAL, verbatim)

File: `src/modules/reply-composer.ts` (NEW). All exports listed in source order.

### §1.1 `ReplyContext`

```ts
import type { Directive } from './reply-planner.js';

/**
 * Context the Replyer needs to compose a reply, beyond the Directive itself.
 * Independent of chat.ts internals so the Replyer is testable in isolation.
 *
 * INVARIANT: caller (R9.3 chat.ts) supplies every field at the call site.
 * The Replyer normalizes inputs internally where needed (per
 * feedback_normalize_inside_helper) — callers pass raw values.
 */
export interface ReplyContext {
  /** QQ group id. Telemetry only — no per-group branching in the Replyer. */
  readonly groupId: string;

  /**
   * Trigger message body. Caller passes raw; Replyer treats it as opaque
   * data (it never reaches the LLM directly from this field — it lives in
   * `userContent` already, assembled by the caller).
   */
  readonly triggerContent: string;

  /** Sanitized nickname of the trigger sender. Telemetry only. */
  readonly triggerNickname: string;

  /**
   * Existing chat.ts system prompt blocks, in their existing order.
   * R9.1 prepends the directive block as a first slot with `cache: false`
   * (per R9-superset DESIGN §2.1) and forwards the whole array to
   * IClaudeClient.complete. Caller is responsible for v1/v2/STATIC_CHAT_DIRECTIVES
   * blocks; R9.1 does not re-derive them.
   */
  readonly systemBlocks: ReadonlyArray<{ readonly text: string; readonly cache: boolean }>;

  /**
   * User-content payload for IClaudeClient.complete. Caller assembles per
   * existing chat.ts userContent assembly.
   */
  readonly userContent: string;

  /**
   * Lookup helper: numeric fact id -> {term, meaning}. Used only by
   * assembleDirectiveBlock to render the must_use_facts lines.
   * Empty Map is a valid value when there are no facts.
   *
   * KEY TYPE: number (matches existing helper at reply-planner.ts:404-426).
   * Directive.requiredFactIds is string[] — renderer converts via Number().
   */
  readonly factsByIdMap: ReadonlyMap<number, { readonly term: string; readonly meaning: string }>;

  /** Chat model identifier. Caller computes via existing _pickChatModel(). */
  readonly model: string;

  /** Max output tokens. Caller passes existing chat.ts value (typically 600..2048). */
  readonly maxTokens: number;
}
```

### §1.2 `ComposeResult`

```ts
/**
 * Output of a Replyer compose() call. Replyer is a pass-through to the
 * underlying LLM client; success returns text + token usage. Failures
 * propagate as typed errors so chat.ts retry/regen logic decides whether
 * to retry (per feedback_metadata_on_result_not_side_channel).
 */
export interface ComposeResult {
  /** LLM-generated reply text. Pass-through; no post-processing in R9.1. */
  readonly text: string;

  /** Token usage, pass-through from IClaudeClient.complete. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;

  /**
   * Echoed back from caller for telemetry. R9.3 will read this and attach
   * to BaseResultMeta. Same reference as the input Directive — Directive is
   * readonly all the way down so no defensive copy.
   */
  readonly directiveSnapshot: Directive;

  /**
   * Soft-violation telemetry: directive said tiny, output exceeded budget,
   * directive listed forbiddenTokens that the LLM nonetheless produced, etc.
   * R9.1 is observe-only — caller does NOT veto-and-regen on these.
   * Empty array (NOT null/undefined) when no violations.
   */
  readonly violations: ReadonlyArray<DirectiveViolation>;
}
```

### §1.3 `DirectiveViolation`

```ts
/**
 * Soft violation kinds. R9.1 emits two:
 *   - 'length-exceeded': output character count > lengthBudget cap * tolerance.
 *   - 'forbidden-token': a token from directive.forbiddenTokens appears in
 *     output text after CJK compact-whitespace normalization.
 *
 * R9.5+ may add more (fact-not-cited, mode-mismatch, etc.) once telemetry
 * justifies. The discriminated-union shape leaves room for that without
 * a breaking change.
 */
export type DirectiveViolation =
  | {
      readonly kind: 'length-exceeded';
      /** Char cap from LENGTH_BUDGET_CHAR_CAP[directive.lengthBudget]. */
      readonly cap: number;
      /** Actual output text length (Unicode code points; matches String.length). */
      readonly actual: number;
    }
  | {
      readonly kind: 'forbidden-token';
      /** The forbidden token from directive.forbiddenTokens that matched. Already compact-whitespaced. */
      readonly token: string;
    };
```

Note on `'forbidden-token'`: the violation does NOT carry `position` (PLAN
briefing item suggested it). Reasoning: position is meaningless after the
compact-whitespace normalization (string indices in the normalized form
don't map back to user-visible positions). The token identity alone is
sufficient telemetry for R9.4+ tuning. Adding `position` later (in raw
form) is a non-breaking extension.

### §1.4 `ReplyerContractError`

```ts
/**
 * Thrown by compose() when the input shape violates the Replyer's contract.
 * Distinct from IClaudeClient errors (ClaudeApiError / ClaudeParseError) so
 * tests + integration can assert separately. R9.3 chat.ts catches LLM
 * errors for fail-open fallback; ReplyerContractError is a programmer bug
 * and should NOT be caught — it indicates a caller-side defect.
 *
 * Code -> message format (English; tests assert on .code, message is
 * dev-readable diagnostic only):
 *   'silent-directive': "Replyer cannot compose for directive.mode === 'silent'; caller must short-circuit before compose()"
 *   'empty-system'    : "Replyer requires at least one system block in ReplyContext.systemBlocks"
 *   'empty-user'      : "Replyer requires non-empty ReplyContext.userContent"
 *   'empty-model'     : "Replyer requires non-empty ReplyContext.model"
 */
export class ReplyerContractError extends Error {
  readonly code: 'silent-directive' | 'empty-system' | 'empty-user' | 'empty-model';

  constructor(code: ReplyerContractError['code'], message: string) {
    super(message);
    this.name = 'ReplyerContractError';
    this.code = code;
  }
}
```

Why English message (not Chinese): Replyer error messages surface in
server logs / stack traces / test output, none of which are user-facing.
Chinese-text errors in this code path would be inconsistent with the rest
of `src/utils/errors.ts` (English). The Replyer's *prompt* text (the
directive block) is Chinese — that's user-facing tone. Errors are for
developers.

### §1.5 `IReplyer`

```ts
/**
 * Replyer (a.k.a. composer). One method: compose. Consumes a Directive +
 * ReplyContext and returns text. Always calls the underlying LLM exactly
 * once. Never modifies the Directive. Never veto-and-regens (OUT for R9.1).
 *
 * Errors:
 *   - ReplyerContractError on contract violations (silent directive / empty
 *     fields). Programmer bug. Must NOT be caught for fail-open.
 *   - ClaudeApiError / ClaudeParseError on LLM errors. Caller (R9.3 chat.ts)
 *     wraps in try/catch and falls back to existing _generateReplyImpl path.
 */
export interface IReplyer {
  compose(directive: Directive, ctx: ReplyContext): Promise<ComposeResult>;
}
```

Final signature locked: `compose(directive: Directive, ctx: ReplyContext): Promise<ComposeResult>`.
- Two positional args (matches `ReplyPlanner.plan(ctx, signal)` two-arg shape).
- Returns `Promise<ComposeResult>` (never `null`); failures throw.
- No `signal` parameter (see §2.3).

## §2 ReplyComposer class skeleton (FINAL)

File: `src/modules/reply-composer.ts` (same file as §1).

### §2.1 Class shape

```ts
import type { IClaudeClient } from '../ai/claude.js';
import type { Logger } from 'pino';
import {
  assembleDirectiveBlock,
  LENGTH_BUDGET_CHAR_CAP,
  type Directive,
} from './reply-planner.js';

/**
 * Constructor options. logger is optional; when absent, soft-violation
 * telemetry is silently dropped. Tests pass a no-op logger or omit.
 */
export interface ReplyComposerOptions {
  readonly logger?: Logger;
}

/**
 * Stateless composer. No cache, no per-call state. Matches groupmate-voice.ts
 * + style-learner.ts compose-only-module precedent.
 */
export class ReplyComposer implements IReplyer {
  constructor(
    private readonly llm: IClaudeClient,
    private readonly opts: ReplyComposerOptions = {},
  ) {}

  async compose(directive: Directive, ctx: ReplyContext): Promise<ComposeResult> {
    // Step 1: Boundary validator (per feedback_validator_at_every_boundary).
    //         Throws ReplyerContractError for programmer bugs.
    this._validateInputs(directive, ctx);

    // Step 2: Assemble directive block via existing helper. R9.1 does NOT
    //         re-derive prompt text — assembleDirectiveBlock is locked at
    //         reply-planner.ts:404-458 (commit 4258159) and matches
    //         R9-superset DESIGN §2.2 verbatim.
    const directiveBlock = assembleDirectiveBlock(directive, ctx.factsByIdMap);

    // Step 3: Prepend directive block to systemBlocks as first slot with
    //         cache: false (per R9-superset DESIGN §2.1). NEW array; never
    //         mutates ctx.systemBlocks (immutability rule).
    const systemBlocks = [
      { text: directiveBlock, cache: false as const },
      ...ctx.systemBlocks,
    ];

    // Step 4: Single LLM call. Same shape as chat.ts:3293-3319 chatRequest.
    //         No model swap; ctx.model passes through opaquely.
    //         Errors propagate (ClaudeApiError / ClaudeParseError) — caller
    //         owns retry/fail-open at chat.ts integration level.
    const resp = await this.llm.complete({
      model: ctx.model,
      maxTokens: ctx.maxTokens,
      system: systemBlocks,
      messages: [{ role: 'user', content: ctx.userContent }],
    });

    // Step 5: Soft-violation observability (log only — NEVER veto in R9.1).
    const violations = this._scanViolations(directive, resp.text);
    if (violations.length > 0 && this.opts.logger !== undefined) {
      this.opts.logger.debug(
        {
          groupId: ctx.groupId,
          mode: directive.mode,
          lengthBudget: directive.lengthBudget,
          violationCount: violations.length,
          violationKinds: violations.map(v => v.kind),
        },
        'reply-composer directive violations (observe-only)',
      );
    }

    // Step 6: Return immutable result (per feedback_metadata_on_result_not_side_channel).
    return {
      text: resp.text,
      inputTokens: resp.inputTokens,
      outputTokens: resp.outputTokens,
      cacheReadTokens: resp.cacheReadTokens,
      cacheWriteTokens: resp.cacheWriteTokens,
      directiveSnapshot: directive,
      violations,
    };
  }

  // ─── Private helpers ─────────────────────────────────────────────────

  private _validateInputs(directive: Directive, ctx: ReplyContext): void {
    if (directive.mode === 'silent') {
      throw new ReplyerContractError(
        'silent-directive',
        "Replyer cannot compose for directive.mode === 'silent'; caller must short-circuit before compose()",
      );
    }
    if (ctx.systemBlocks.length === 0) {
      throw new ReplyerContractError(
        'empty-system',
        'Replyer requires at least one system block in ReplyContext.systemBlocks',
      );
    }
    // Helpers normalize input internally (per feedback_normalize_inside_helper):
    // trim before length check so '   ' / '\n\n' don't pass.
    if (ctx.userContent.trim().length === 0) {
      throw new ReplyerContractError(
        'empty-user',
        'Replyer requires non-empty ReplyContext.userContent',
      );
    }
    if (ctx.model.trim().length === 0) {
      throw new ReplyerContractError(
        'empty-model',
        'Replyer requires non-empty ReplyContext.model',
      );
    }
  }

  private _scanViolations(directive: Directive, text: string): DirectiveViolation[] {
    const out: DirectiveViolation[] = [];

    // Scan A: length budget. cap * 1.3 tolerance (see §3.2 reasoning).
    const cap = LENGTH_BUDGET_CHAR_CAP[directive.lengthBudget];
    if (text.length > Math.floor(cap * LENGTH_TOLERANCE_MULTIPLIER)) {
      out.push({ kind: 'length-exceeded', cap, actual: text.length });
    }

    // Scan B: forbidden tokens. Compact-whitespace normalize both sides
    // (per feedback_cjk_compact_whitespace_match). Defensive double-apply
    // on tok is cheap (validateDirective already normalized, but the
    // helper normalizes input internally — caller may have hand-built
    // a Directive in tests).
    if (directive.forbiddenTokens.length > 0) {
      const normalizedText = text.replace(/\s+/g, '');
      for (const tok of directive.forbiddenTokens) {
        const normTok = tok.replace(/\s+/g, '');
        if (normTok.length === 0) continue;
        if (normalizedText.includes(normTok)) {
          out.push({ kind: 'forbidden-token', token: normTok });
        }
      }
    }

    return out;
  }
}
```

### §2.2 LLM model = same as current chat LLM

`compose()` consumes `ctx.model` opaquely. Caller (R9.3 chat.ts) computes
this via existing `ChatModule._pickChatModel(...)` at `chat.ts:3970-4030`,
which routes between:

- **`RUNTIME_CHAT_MODEL`** (default `'claude-sonnet-4-6'` per `src/config.ts:18-19`).
- `CHAT_DEEPSEEK_MODEL` when `DEEPSEEK_ENABLED()`.
- Various escalation tripwires (sensitive / meta-tech / political / direct
  engagement) all return `primary` which is `claude-sonnet-4-6` in the
  default config.

R9.1 unit tests pass `ctx.model = 'claude-sonnet-4-6'` (the production
default literal — verified at `src/config.ts:18`). No live LLM. No model
selection logic in the Replyer.

This honors PLAN §2.5 ("Replyer LLM = same as current chat LLM (no model
swap)") and R9-superset DESIGN-NOTE §2.4.

### §2.3 No AbortSignal in R9.1

`compose()` does NOT accept an `AbortSignal`. PLAN §8 item 6 left this
open; Designer locks **OUT** for R9.1.

Rationale:
- `IClaudeClient.complete` (`src/ai/claude.ts:52-58`) does NOT accept a
  signal parameter. The underlying Anthropic Agent SDK `query()` call
  inside `ClaudeClient.complete` (`src/ai/claude.ts:86-106`) likewise has
  no abort plumbing in the current shape.
- Adding `signal` to the Replyer contract while the underlying client
  cannot honor it would mislead callers — they would assume cancellation
  works and discover otherwise only under load.
- Existing concurrency-control gates in chat.ts (`inFlightGroups` set,
  `_generateReplyImpl` outer try/finally) provide turn-level cancellation
  semantics for the production caller.
- Re-evaluate in R9.5+ if the Anthropic SDK gains AbortSignal support; at
  that point `IClaudeClient` adds it first, then the Replyer contract.

This differs from `ReplyPlanner.plan(ctx, signal)` because the Planner
implements its own `Promise.race` + `AbortController` timeout
(`reply-planner.ts:613-637`); the Replyer does not — it delegates the
single LLM call and propagates errors.

### §2.4 Logger injection

`ReplyComposerOptions.logger` is **optional, constructor-injected**. When
absent, `_scanViolations` results are still computed (and surface on
`ComposeResult.violations` for the caller) but the debug log line is not
emitted.

Rationale (PLAN §8 item 7):
- Matches `ReplyPlanner` constructor at `reply-planner.ts:587-602`, which
  takes `Logger` as a constructor arg.
- Test ergonomics: tests instantiate `new ReplyComposer(stubLLM)` with no
  options and never reach the log path. No module-level singleton state
  to reset between tests.
- The Replyer is stateless — making the logger a module-level singleton
  (like `pre-chat-judge.ts:100`) creates an *implicit* dependency on
  `initLogger()` having been called, which would couple test harness
  setup to module loading. Constructor injection makes the dependency
  explicit.
- Optional vs required: the production caller (R9.3 chat.ts) WILL pass a
  logger; tests do not need to. Required + nullable would force tests to
  build a no-op logger stub. Optional is friendlier with no production
  risk (caller always passes one).

### §2.5 What is intentionally NOT in the contract

These belong to R9.2..R9.6 (mirrors PLAN §2.3):

- **Planner integration** — `compose()` does not invoke the Planner. R9.3
  owns "call Planner, then call Replyer".
- **Feature flag plumbing** — `compose()` runs unconditionally when
  called. R9.3 owns the gate at the call site.
- **Sticker-token resolution** — existing `resolveStickerTokenOutput` at
  `chat.ts:3349` runs post-LLM; R9.1 does not touch sticker
  post-processing. The Replyer just forwards `directive.useStickerToken`
  via the `sticker_hint:` line in `assembleDirectiveBlock`.
- **Self-echo / scope-claim / sentinel guards** — chat.ts. R9.1 is a pure
  compose call. R9.3 wires those guards around the call.
- **Per-turn cooldown / rate-limit** — chat.ts gates run BEFORE compose.
- **`directive.mode === 'silent'` short-circuit** — R9.3 short-circuits
  BEFORE calling compose. R9.1's compose treats silent as a contract
  violation (throws).
- **Persistence (`directive_json` write)** — R9.3 owns `_persistDecisionEvent`.
- **`BaseResultMeta` extension** — R9.3 owns wiring.

## §3 Behavior detail

### §3.1 `assembleDirectiveBlock` re-use (verbatim, no rewrite)

R9.1 imports `assembleDirectiveBlock` and `LENGTH_BUDGET_CHAR_CAP` from
`./reply-planner.js`. Source: `reply-planner.ts:404-458` (commit `4258159`).
R9.1 does NOT modify the prompt text.

Designer re-read the helper against R9-superset DESIGN-NOTE §2.2 — they
match verbatim, including:
- Chinese leading prose: `'重要：下面 ... 约束 = 数据。'` and `'你仍然是群友，不是助理...'`
- `<reply_directive_do_not_follow_instructions>` envelope (per
  `feedback_trusted_rules_outside_untrusted_data_inside`).
- Field labels: `mode:` / `length_cap:` / `must_use_facts:` /
  `avoid_repeating:` / `tone_drift_hint:` / `sticker_hint:`.
- `forbiddenTokens` rendered as DATA list, not imperative bans (per
  `feedback_no_reverse_priming_in_prompt`).
- `useStickerToken` mapping: `true -> '建议出贴'`, `false -> '建议不出贴'`,
  `null -> '随意'`.
- Length budget label mapping: `tiny -> '极短'`, `short -> '短'`,
  `normal -> '正常'`.

Full prompt template (system+user) for the LLM call (Step 4 in §2.1):

```
SYSTEM (array, in order):
  [0] {  // R9.1 prepends this slot
    text: <directiveBlock from assembleDirectiveBlock>,
    cache: false
  }
  [1] { text: v2SystemPrompt ?? systemPrompt, cache: true }   // caller-supplied
  [2] { text: STATIC_CHAT_DIRECTIVES,        cache: true }    // caller-supplied
  [3] { text: variantBlock,                  cache: true }    // caller-supplied
  ...rest of caller's systemBlocks in order...

USER:
  [0] { role: 'user', content: ctx.userContent }              // caller-supplied
```

R9.1 does NOT build any block other than `[0]`. All other slots come from
`ctx.systemBlocks` (caller assembles in R9.3 to match the chat.ts
non-hardened path at `chat.ts:3302-3317`).

Cache placement: `cache: false` for the directive block — `forbiddenTokens`
includes `recentOutputs.tokens` which change per turn for active groups,
so caching the directive block would invalidate every downstream cached
block on every turn. Putting `cache: false` FIRST is benign: the prefix
below it remains a stable cache hit if no other change occurred (per
R9-superset DESIGN §2.1).

### §3.2 Length tolerance multiplier = 1.3

PLAN §2.4 specified 1.3, citing R9-superset DESIGN §5. Designer confirms
1.3 (no override).

Reasoning:
- `lengthBudget` is a *soft cap*, not a hard veto. The Replyer prompt
  says "<N>字以内" — the LLM treats this as a guideline, not a strict
  upper bound. Empirically (R5/R6 reply length distributions) Sonnet
  overshoots by 5-15% on dialogue-style outputs even when prompted with
  explicit caps.
- Tolerance < 1.0 (e.g. cap itself): would log violations on every output
  near the budget — noisy, low signal.
- Tolerance 1.0: Designer rejected — same noise problem, no headroom.
- Tolerance 1.2: too tight; flags ~30% of `tiny` outputs that humans
  would not consider over-budget.
- Tolerance 1.3: floor where genuine over-runs surface — `tiny` cap 30 *
  1.3 = 39 chars, so a 40-char reply flags. `short` cap 80 * 1.3 = 104.
  `normal` cap 200 * 1.3 = 260.
- Tolerance 1.5+: flags only egregious over-runs — would miss the 50-char
  `tiny` outputs that are the actual telemetry target.

Implementation: pin at module scope as `const LENGTH_TOLERANCE_MULTIPLIER = 1.3;`
(NOT in `ReplyComposerOptions` — telemetry tuning is a per-PR change, not
a per-instance knob). Use `Math.floor(cap * 1.3)` for the comparison so
30 * 1.3 yields integer 39 not float 39.0 (matches PLAN §3.3 spec).

T-8 in §4 asserts: `lengthBudget: 'tiny'` (cap 30), 50-char output ->
violation `{kind: 'length-exceeded', cap: 30, actual: 50}` (50 > 39).

### §3.3 `factsByIdMap` numeric-id convention

PLAN §8 item 5 / R9-superset DEV-READY surfaced a type-drift risk:
`requiredFactIds` is `string[]` while the renderer's lookup map uses
numeric keys.

Designer locks: **map keys are `number`, requiredFactIds are `string[]`,
renderer converts via `Number()` once at lookup.**

This matches the existing `assembleDirectiveBlock` helper at
`reply-planner.ts:415-417`:

```ts
for (const idStr of directive.requiredFactIds) {
  const idNum = Number(idStr);
  const meta = Number.isFinite(idNum) ? factsByIdMap.get(idNum) : undefined;
  ...
}
```

R9.1 inherits this; does NOT re-introduce drift. The `ReplyContext.factsByIdMap`
field type pins `ReadonlyMap<number, ...>` so callers (R9.3 chat.ts) cannot
accidentally pass a string-keyed map.

Rationale for picking number:
- chat.ts `matchedFactRetrievalIds` is `number[]` upstream (R3 facts gate).
- chat.ts already builds a `Map<number, ...>` at the call site.
- Directive serialization (`directiveToJson` at `reply-planner.ts:192-203`)
  preserves `requiredFactIds` as `string[]` for log stability — IDs from
  past Planner LLM outputs may be parseable-as-number strings (e.g. `"42"`)
  but the Directive type stays string-typed for replay safety.
- Single boundary conversion (`Number(idStr)`) keeps the rest of the call
  graph type-stable.

R9.1 has zero new conversion sites — it just consumes the existing
contract. T-5 in §4 exercises the lookup happy path with `factsByIdMap`
mapping `42` (number key) to `{term: 'ras live', meaning: '11/15福冈'}`,
asserting the rendered line `- ras live: 11/15福冈` appears in the
directive block.

### §3.4 No internal state

`ReplyComposer` is stateless. No cache, no in-memory log, no counter.
Side effects:
- (a) the LLM call,
- (b) optional debug log on violation.

Matches `groupmate-voice.ts` / `style-learner.ts` precedent.

Tests assert no leakage: T-11 (§4) checks that calling compose() twice
back-to-back with different inputs produces independent results; no
hidden state survives.

## §4 Test matrix v2 (FINAL — 13 tests)

File: `test/modules/reply-composer.test.ts`. Vitest. Stub `IClaudeClient`
via plain object literal matching `test/modules/reply-planner.test.ts`
style at lines 22-41.

Helper functions at top of test file (mirror `reply-planner.test.ts:43-73`):

```ts
function makeClaudeStub(behavior: 'resolve' | 'reject', payload?: ClaudeResponse | Error): IClaudeClient {
  return {
    complete: vi.fn().mockImplementation(() => {
      if (behavior === 'resolve') return Promise.resolve(payload as ClaudeResponse);
      return Promise.reject(payload ?? new Error('reject'));
    }),
    describeImage: vi.fn(),
    visionWithPrompt: vi.fn(),
  };
}

function makeBaseDirective(overrides: Partial<Directive> = {}): Directive {
  return {
    mode: 'reply',
    lengthBudget: 'normal',
    requiredFactIds: [],
    forbiddenTokens: [],
    toneHint: '',
    useStickerToken: null,
    source: 'llm-planner',
    latencyMs: 100,
    ...overrides,
  };
}

function makeBaseCtx(overrides: Partial<ReplyContext> = {}): ReplyContext {
  return {
    groupId: 'g1',
    triggerContent: '下场live什么时候',
    triggerNickname: 'Alice',
    systemBlocks: [{ text: 'base system prompt', cache: true }],
    userContent: 'user trigger payload',
    factsByIdMap: new Map(),
    model: 'claude-sonnet-4-6',
    maxTokens: 600,
    ...overrides,
  };
}

function makeStubResp(text: string, overrides: Partial<ClaudeResponse> = {}): ClaudeResponse {
  return {
    text,
    inputTokens: 100,
    outputTokens: text.length,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    ...overrides,
  };
}
```

### §4.1 Contract-violation tests (4)

```ts
describe('reply-composer — contract validators', () => {
  it('T-1 throws ReplyerContractError on directive.mode === silent', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('x'));
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective({ mode: 'silent' });
    await expect(composer.compose(directive, makeBaseCtx())).rejects.toMatchObject({
      name: 'ReplyerContractError',
      code: 'silent-directive',
    });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('T-2 throws empty-system when systemBlocks is empty', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('x'));
    const composer = new ReplyComposer(llm);
    const ctx = makeBaseCtx({ systemBlocks: [] });
    await expect(composer.compose(makeBaseDirective(), ctx)).rejects.toMatchObject({
      name: 'ReplyerContractError',
      code: 'empty-system',
    });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('T-3 throws empty-user when userContent is empty/whitespace', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('x'));
    const composer = new ReplyComposer(llm);
    const ctx = makeBaseCtx({ userContent: '   \n\t' });
    await expect(composer.compose(makeBaseDirective(), ctx)).rejects.toMatchObject({
      name: 'ReplyerContractError',
      code: 'empty-user',
    });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('T-4 throws empty-model when model is empty/whitespace', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('x'));
    const composer = new ReplyComposer(llm);
    const ctx = makeBaseCtx({ model: '   ' });
    await expect(composer.compose(makeBaseDirective(), ctx)).rejects.toMatchObject({
      name: 'ReplyerContractError',
      code: 'empty-model',
    });
    expect(llm.complete).not.toHaveBeenCalled();
  });
});
```

### §4.2 Prompt-assembly tests (3)

```ts
describe('reply-composer — directive block in system array', () => {
  it('T-5 fact_answer with requiredFactIds renders must_use_facts line via factsByIdMap', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('11/15福冈那场'));
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective({
      mode: 'fact_answer',
      lengthBudget: 'short',
      requiredFactIds: ['42'],
    });
    const factsByIdMap = new Map([
      [42, { term: 'ras live', meaning: '11/15福冈' }],
    ]);
    const ctx = makeBaseCtx({ factsByIdMap });
    await composer.compose(directive, ctx);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    const req = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const directiveText = req.system[0].text;
    expect(directiveText).toContain('mode: fact_answer');
    expect(directiveText).toContain('must_use_facts:');
    expect(directiveText).toContain('- ras live: 11/15福冈');
    expect(req.system[0].cache).toBe(false);
  });

  it('T-6 forbiddenTokens render as avoid_repeating list (DATA, not imperative)', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('回复'));
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective({ forbiddenTokens: ['哈哈哈', '确实'] });
    await composer.compose(directive, makeBaseCtx());
    const req = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const directiveText = req.system[0].text;
    expect(directiveText).toContain('avoid_repeating:');
    expect(directiveText).toContain('- 哈哈哈');
    expect(directiveText).toContain('- 确实');
    expect(directiveText).not.toContain('不要说');  // no reverse priming
  });

  it('T-7 useStickerToken false/null render correct sticker_hint label', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('回复'));
    const composer = new ReplyComposer(llm);
    await composer.compose(makeBaseDirective({ useStickerToken: false }), makeBaseCtx());
    let req = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.system[0].text).toContain('sticker_hint: 建议不出贴');
    (llm.complete as ReturnType<typeof vi.fn>).mockClear();
    await composer.compose(makeBaseDirective({ useStickerToken: null }), makeBaseCtx());
    req = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.system[0].text).toContain('sticker_hint: 随意');
  });
});
```

### §4.3 Sticker-positive happy path (1, NEW per §0 item 7)

```ts
describe('reply-composer — sticker hint positive', () => {
  it('T-13 useStickerToken true renders sticker_hint: 建议出贴', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('回复'));
    const composer = new ReplyComposer(llm);
    await composer.compose(makeBaseDirective({ useStickerToken: true }), makeBaseCtx());
    const req = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.system[0].text).toContain('sticker_hint: 建议出贴');
  });
});
```

This T-13 closes a coverage gap: PLAN's T-7 only tested `false` and
`null`, but `true` is the third arm of the `useStickerToken` enum and a
common path in production. Adding T-13 keeps every Directive-shape edge
covered (per `feedback_edge_testing_soul`).

### §4.4 Soft-violation tests (2)

```ts
describe('reply-composer — soft violations (observe-only)', () => {
  it('T-8 length-exceeded fires when output > cap * 1.3', async () => {
    // tiny cap = 30; tolerance 1.3 -> threshold 39; 50 > 39 -> violation
    const fiftyChar = 'a'.repeat(50);
    const llm = makeClaudeStub('resolve', makeStubResp(fiftyChar));
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective({ lengthBudget: 'tiny' });
    const result = await composer.compose(directive, makeBaseCtx());
    expect(result.violations).toContainEqual({
      kind: 'length-exceeded', cap: 30, actual: 50,
    });
  });

  it('T-9 forbidden-token fires after CJK compact-whitespace match', async () => {
    // forbidden '哈哈哈'; output '这事 哈 哈 哈 真的' compact-WS -> '这事哈哈哈真的'
    const llm = makeClaudeStub('resolve', makeStubResp('这事 哈 哈 哈 真的'));
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective({ forbiddenTokens: ['哈哈哈'] });
    const result = await composer.compose(directive, makeBaseCtx());
    expect(result.violations).toContainEqual({
      kind: 'forbidden-token', token: '哈哈哈',
    });
  });
});
```

### §4.5 Pass-through + immutability (2)

```ts
describe('reply-composer — pass-through + immutability', () => {
  it('T-10 returns LLM tokens + directive snapshot identity, empty violations on happy path', async () => {
    const resp = makeStubResp('就那场', {
      inputTokens: 100, outputTokens: 5, cacheReadTokens: 80, cacheWriteTokens: 0,
    });
    const llm = makeClaudeStub('resolve', resp);
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective();
    const result = await composer.compose(directive, makeBaseCtx());
    expect(result.text).toBe('就那场');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(5);
    expect(result.cacheReadTokens).toBe(80);
    expect(result.cacheWriteTokens).toBe(0);
    expect(result.violations).toEqual([]);  // empty array, not null
    expect(result.directiveSnapshot).toBe(directive);  // identity, not deep-copy
  });

  it('T-11 does not mutate ctx.systemBlocks or directive; LLM receives prepended array', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('x'));
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective({ forbiddenTokens: ['x'] });
    const directiveSnap = JSON.stringify(directive);
    const baseSystemBlocks = [
      { text: 'a', cache: true } as const,
      { text: 'b', cache: true } as const,
    ];
    const systemBlocksSnap = JSON.stringify(baseSystemBlocks);
    const ctx = makeBaseCtx({ systemBlocks: baseSystemBlocks });
    await composer.compose(directive, ctx);
    expect(JSON.stringify(directive)).toBe(directiveSnap);
    expect(JSON.stringify(baseSystemBlocks)).toBe(systemBlocksSnap);
    const req = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.system).toHaveLength(3);  // 2 + 1 prepended
    expect(req.system[0].cache).toBe(false);  // prepended slot
    expect(req.system[1].text).toBe('a');     // original [0] now at [1]
    expect(req.system[2].text).toBe('b');
  });
});
```

### §4.6 Error propagation (1)

```ts
describe('reply-composer — error propagation', () => {
  it('T-12 propagates ClaudeApiError unchanged (no swallow, no replacement)', async () => {
    const apiError = new ClaudeApiError(new Error('rate-limited'));
    const llm = makeClaudeStub('reject', apiError);
    const composer = new ReplyComposer(llm);
    await expect(composer.compose(makeBaseDirective(), makeBaseCtx())).rejects.toBe(apiError);
  });
});
```

### §4.7 Test count summary

13 first-class tests:
- 4 contract validators (T-1..T-4)
- 3 prompt assembly (T-5..T-7)
- 1 sticker-positive happy path (T-13, NEW)
- 2 soft violations (T-8, T-9)
- 2 pass-through + immutability (T-10, T-11)
- 1 error propagation (T-12)

All map to a §1/§2 contract clause or a §3 method. No future-feature
tests (no retry-on-violation, no AbortSignal, no fact-presence scan).
Exceeds PLAN's 12-test floor.

## §5 Out of scope (deferred — no expansion vs PLAN)

Locked, do not expand:

| OOS item                                          | Lands in |
|---------------------------------------------------|----------|
| Planner module (already on branch as `4258159`)   | R9.2     |
| chat.ts wire (`_generateReplyImpl` calls Replyer) | R9.3     |
| Feature flag `chat_planner_lite_v1`               | R9.3     |
| DB ALTER `chat_decision_events.directive_json`    | R9.3     |
| `schema.sql` updates                              | R9.3     |
| `BaseResultMeta` extension                        | R9.3     |
| Latency log line `chat timing (planner)`          | R9.3     |
| `_pickChatModel` integration                      | R9.3     |
| Sticker-token resolver post-Replyer interaction   | R9.3     |
| Offline benchmark on R6 gold-1027                 | R9.4     |
| Required-fact presence detection in output        | R9.5+    |
| Veto-and-regen on directive violation             | R9.5+    |
| Tune iteration                                    | R9.5     |
| Real-group canary on group `958751334`            | R9.6     |
| `compose()` AbortSignal                           | R9.5+ (gated on IClaudeClient signal support) |

## §6 Standing rules check (each, explicit, verbatim from briefing)

- **ASCII single quotes only** — verified throughout this DESIGN; no smart
  quotes (file is ASCII source + CJK content only; the four Unicode
  smart-quote codepoints U+201C / U+201D / U+2018 / U+2019 are absent).
  Per `feedback_no_smart_quotes`.
- **No emojis** — none present in source / commits / docs.
- **No `Co-Authored-By` lines** — none present. Per `feedback_no_coauthor`.
- **No `.claude/` paths in commits** — DESIGN file lives at repo-relative
  `docs/specs/r9-1-replyer-skeleton-DESIGN.md`. Per `feedback_no_claude_on_github`.
- **Edge tests mandatory** — §4 covers 13 first-class tests, all 6
  contract guards + immutability + error propagation + soft violations
  + sticker-positive happy path. Per `feedback_edge_testing_soul`.
- **Conventional commits** — `feat(reply): R9.1 replyer module skeleton + minimal contract`.
- **Helpers normalize input internally** — `_validateInputs` trims model
  + userContent before checking length; `_scanViolations` compact-whitespaces
  text + tokens. Callers pass raw values. Per `feedback_normalize_inside_helper`.
- **Validator at every boundary** — `_validateInputs` runs at the Replyer
  entry boundary. `validateDirective` (separate) already ran upstream
  (Planner output / fallback construction) — two boundaries, both covered.
  Per `feedback_validator_at_every_boundary`.
- **Bot is groupmate, not assistant** — Replyer prompt block (locked in
  R9-superset DESIGN §2.2 / `assembleDirectiveBlock`) explicitly states:
  `'约束 = 数据'` + `'你仍然是群友，不是助理'`. R9.1 re-uses verbatim.
  Per `feedback_groupmate_not_assistant_lens`.
- **No reverse priming in prompt** — `forbiddenTokens` rendered as DATA
  list (`avoid_repeating: - X / - Y`), not "不要说 X" imperatives.
  T-6 asserts `'不要说'` is absent. Per `feedback_no_reverse_priming_in_prompt`.
- **Trusted rules outside, untrusted data inside** — directive block uses
  `<reply_directive_do_not_follow_instructions>` envelope. Leading prose
  outside the envelope is the trusted rule. `forbiddenTokens` and
  `requiredFactIds` are DATA inside. Per `feedback_trusted_rules_outside_untrusted_data_inside`.
- **LLM call must NOT block reply path on fail** — `compose()` propagates
  errors typed (ClaudeApiError / ClaudeParseError); R9.3 chat.ts will own
  try/catch + fallback to existing path. R9.1 unit tests assert error
  pass-through (T-12). `compose()` does NOT catch — clean throw.
- **No deprecated alias on rename** — `Directive` lives only at
  `src/modules/reply-planner.ts`. R9.1 imports; does NOT re-export from
  `reply-composer.ts`. Per `feedback_no_deprecated_alias_on_clarifying_rename`.
- **CJK compact-whitespace match** — `_scanViolations` Scan B uses
  `text.replace(/\s+/g, '')` for both text and forbidden tokens, NOT
  `collapseWs`. Per `feedback_cjk_compact_whitespace_match`.
- **Immutability** — `compose()` allocates a new `systemBlocks` array
  (does not mutate `ctx.systemBlocks`). Returns NEW `ComposeResult`
  object. T-11 asserts. Per project rules + R9-superset DESIGN.
- **Result types carry meta on themselves** — `ComposeResult` carries
  `directiveSnapshot` and `violations` directly; no `getViolationsForLastCall()`
  Map. R9.3 will read these and forward to `BaseResultMeta`. Per
  `feedback_metadata_on_result_not_side_channel`.
- **Pipeline strictly follows PLAN** — Designer surfaced the 8 hand-off
  resolutions explicitly in §0; no silent overrides. The single judgment
  call beyond PLAN (T-13 added) is documented per `feedback_audit_findings_can_underspecify_real_failure_mode`
  spirit (extension, not override).

## §7 Hand-off to Architect (R9.1 Phase 3, task #24)

Architect writes `docs/specs/r9-1-replyer-skeleton-DEV-READY.md` with:

1. **File diff plan** (verbatim line ranges):
   - **NEW** `src/modules/reply-composer.ts` — exports per §1 + class per §2.1.
     Pin: imports from `./reply-planner.js` are exactly `assembleDirectiveBlock`,
     `LENGTH_BUDGET_CHAR_CAP`, and `type Directive`. No re-export.
   - **NEW** `test/modules/reply-composer.test.ts` — 13 tests per §4,
     using vitest + plain-object IClaudeClient stub matching
     `test/modules/reply-planner.test.ts:22-41` style.
   - **NEW** `docs/specs/r9-1-replyer-skeleton-DESIGN.md` (this file, already on disk).

2. **No edits** to existing files. `chat.ts` / `db.ts` / `config.ts` /
   `schema.sql` / `index.ts` / `chat-result.ts` / `reply-planner.ts` are
   untouched. Architect verifies via `git diff master --stat` before
   handing to Developer.

3. **Working-tree reset before commit** — current uncommitted modifications
   to `chat.ts` / `db.ts` / `config.ts` / `index.ts` / `chat-result.ts`
   and the untracked `src/config/reply-planner.ts` MUST be reset to
   match commit `4258159` before staging. ONLY new R9.1 files land.
   Per `feedback_user_coauthors_in_working_tree`: surface to user before
   resetting if any uncommitted change is unrelated to R9.

4. **Commit message** (single commit):
   ```
   feat(reply): R9.1 replyer module skeleton + minimal contract

   - NEW src/modules/reply-composer.ts: ReplyComposer class implementing
     IReplyer; consumes Directive + ReplyContext, single LLM call, returns
     ComposeResult with directiveSnapshot + soft violations.
   - NEW test/modules/reply-composer.test.ts: 13 tests covering 4 contract
     validators, 3 prompt-assembly cases, 1 sticker-positive happy path,
     2 soft-violation observability cases, 2 pass-through+immutability,
     1 error propagation.
   - NEW docs/specs/r9-1-replyer-skeleton-{PLAN,DESIGN}.md.

   Standalone module — not yet imported in the running call graph.
   chat.ts wire-up + feature flag + DB migration land in R9.3.
   ```

5. **PR open command**: `gh pr create --base main --head feat/r9-replyer-lite ...`
   per `feedback_gh_pr_create_explicit_base_head`.

6. **Reviewer Phase 5 explicit asks**:
   - Re-run `npm run build` (tsc 0) and `npm test` independently.
   - Audit new module against §1 contract + §4 test matrix.
   - Verify `git diff master --stat` lists ONLY new files; no edits.
   - Verify `reply-planner.ts` byte-identical to `4258159` (no incidental
     changes).
   - Save review to `.claude/code-reviews.md` per `feedback_code_review_log`.

NO real-LLM benchmark. NO 781-row replay. R9.4 owns those gates.

## §8 References

- `docs/specs/r9-1-replyer-skeleton-PLAN.md` — R9.1 PLAN (locked upstream).
- `docs/specs/r9-replyer-lite-DESIGN-NOTE.md` — R9-superset DESIGN-NOTE
  (Directive shape, prompt block, fallback — locked).
- `docs/specs/r9-replyer-lite-PLAN.md` — R9-superset PLAN (context).
- `src/modules/reply-planner.ts` (commit `4258159`) — exports Directive,
  validateDirective, buildFallbackDirective, ReplyPlanner, assembleDirectiveBlock,
  LENGTH_BUDGET_CHAR_CAP, DIRECTIVE_KEY_ORDER, DIRECTIVE_JSON_KEYS,
  directiveToJson, tolerantParseDirective, extractTopTokens.
  R9.1 imports from this file; does NOT modify it.
- `src/ai/claude.ts:52-58` — `IClaudeClient.complete` signature R9.1 uses.
- `src/ai/claude.ts:22-50` — `CachedSystemBlock` / `ClaudeMessage` /
  `ClaudeRequest` / `ClaudeResponse` shapes.
- `src/utils/errors.ts` — `ClaudeApiError` / `ClaudeParseError` (propagated
  unmodified through compose).
- `src/config.ts:18-19` — `RUNTIME_CHAT_MODEL` default `'claude-sonnet-4-6'`;
  test fixtures use this string.
- `src/modules/chat.ts:3293-3319` — `chatRequest` factory (existing
  non-hardened path); R9.1 mirrors the system-array shape one slot earlier.
- `src/modules/chat.ts:3970-4030` — `_pickChatModel`; R9.3 caller computes
  `ctx.model` via this; R9.1 takes opaquely.
- `src/modules/pre-chat-judge.ts:99-220` — module-shape precedent; R9.1
  mirrors stateless constructor (sans cache, sans Promise.race timeout —
  Replyer delegates timing to caller / IClaudeClient).
- `src/modules/groupmate-voice.ts` — stateless compose-only module
  precedent.
- `test/modules/reply-planner.test.ts:22-73` — test helper style mirrored
  in §4.

---

End of DESIGN. Ready for Architect (Phase 3, task #24).
