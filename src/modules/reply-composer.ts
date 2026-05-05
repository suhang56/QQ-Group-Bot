import type { IClaudeClient } from '../ai/claude.js';
import type { Logger } from 'pino';
import {
  assembleDirectiveBlock,
  LENGTH_BUDGET_CHAR_CAP,
  type Directive,
} from './reply-planner.js';

/**
 * R9.1 — Replyer (composer). Consumes a Directive + ReplyContext and returns
 * a single LLM-generated reply with token usage + soft-violation telemetry.
 *
 * Contract:
 *   - Single LLM call per compose(). No retry / no regen.
 *   - Never modifies the Directive or ctx.systemBlocks.
 *   - directive.mode === 'silent' is a CALLER bug — throws ReplyerContractError.
 *     R9.3 wiring short-circuits silent BEFORE compose().
 *   - Soft violations (length-exceeded, forbidden-token) are observe-only in
 *     R9.1 — surfaced on ComposeResult.violations and optionally logged.
 *   - LLM errors (ClaudeApiError / ClaudeParseError) propagate unchanged so
 *     R9.3 chat.ts can fail-open to the existing reply path.
 *
 * Bot is a groupmate, not an assistant — the prompt block (assembled by
 * assembleDirectiveBlock) explicitly states: '约束 = 数据' and '你仍然是
 * 群友，不是助理'. Replyer does NOT re-derive the prompt text; it imports
 * the helper from reply-planner.ts.
 */

// Length-tolerance multiplier (LOCKED per DESIGN §3.2).
//
// soft-violation threshold: text.length > Math.floor(cap * 1.3).
// 30 → 39 / 80 → 104 / 200 → 260. Module-scope (not per-instance) — telemetry
// tuning is a per-PR change, not a runtime knob.
export const LENGTH_TOLERANCE_MULTIPLIER = 1.3;

// Types (per DESIGN §1).

/**
 * Context the Replyer needs to compose a reply, beyond the Directive itself.
 * Independent of chat.ts internals so the Replyer is testable in isolation.
 *
 * INVARIANT: caller (R9.3 chat.ts) supplies every field at the call site.
 * Replyer normalizes inputs internally where needed (per
 * feedback_normalize_inside_helper) — callers pass raw values.
 */
export interface ReplyContext {
  /** QQ group id. Telemetry only — no per-group branching in the Replyer. */
  readonly groupId: string;

  /**
   * Trigger message body. Caller passes raw; Replyer treats it as opaque
   * data (it never reaches the LLM directly from this field — it lives in
   * userContent already, assembled by the caller).
   */
  readonly triggerContent: string;

  /** Sanitized nickname of the trigger sender. Telemetry only. */
  readonly triggerNickname: string;

  /**
   * Existing chat.ts system prompt blocks, in their existing order.
   * R9.1 prepends the directive block as a first slot with cache: false
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
   * KEY TYPE: number (matches existing helper at reply-planner.ts:404-458).
   * Directive.requiredFactIds is string[] — renderer converts via Number().
   */
  readonly factsByIdMap: ReadonlyMap<number, { readonly term: string; readonly meaning: string }>;

  /** Chat model identifier. Caller computes via existing _pickChatModel(). */
  readonly model: string;

  /** Max output tokens. Caller passes existing chat.ts value (typically 600..2048). */
  readonly maxTokens: number;
}

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

/**
 * Soft violation kinds. R9.1 emits two:
 *   - 'length-exceeded': output character count > cap * LENGTH_TOLERANCE_MULTIPLIER.
 *   - 'forbidden-token': a token from directive.forbiddenTokens appears in
 *     output text after CJK compact-whitespace normalization.
 *
 * R9.5+ may add more (fact-not-cited, mode-mismatch, etc.) once telemetry
 * justifies. The discriminated-union shape leaves room without a breaking
 * change.
 */
export type DirectiveViolation =
  | {
      readonly kind: 'length-exceeded';
      /** Char cap from LENGTH_BUDGET_CHAR_CAP[directive.lengthBudget]. */
      readonly cap: number;
      /** Actual output text length (matches String.length). */
      readonly actual: number;
    }
  | {
      readonly kind: 'forbidden-token';
      /** The forbidden token from directive.forbiddenTokens that matched. Already compact-whitespaced. */
      readonly token: string;
    };

/**
 * Thrown by compose() when the input shape violates the Replyer's contract.
 * Distinct from IClaudeClient errors so tests + integration can assert
 * separately. R9.3 chat.ts catches LLM errors for fail-open fallback;
 * ReplyerContractError is a programmer bug and should NOT be caught.
 */
export class ReplyerContractError extends Error {
  readonly code: 'silent-directive' | 'empty-system' | 'empty-user' | 'empty-model';

  constructor(code: ReplyerContractError['code'], message: string) {
    super(message);
    this.name = 'ReplyerContractError';
    this.code = code;
  }
}

/**
 * Replyer (a.k.a. composer). One method: compose. Always calls the
 * underlying LLM exactly once. Never veto-and-regens (OUT for R9.1).
 *
 * Errors:
 *   - ReplyerContractError on contract violations (programmer bug).
 *   - ClaudeApiError / ClaudeParseError on LLM errors. Caller (R9.3) wraps
 *     in try/catch and falls back to existing _generateReplyImpl path.
 */
export interface IReplyer {
  compose(directive: Directive, ctx: ReplyContext): Promise<ComposeResult>;
}

/**
 * Constructor options. logger is optional; when absent, soft-violation
 * telemetry is silently dropped. Tests pass no options.
 */
export interface ReplyComposerOptions {
  readonly logger?: Logger;
}

// Composer class.

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
    //         Throws ReplyerContractError on programmer bugs.
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
      { text: directiveBlock, cache: false },
      ...ctx.systemBlocks,
    ];

    // Step 4: Single LLM call. Same shape as chat.ts chatRequest factory.
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

  // Private helpers.

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

    // Scan A: length budget. Math.floor keeps comparison integer.
    const cap = LENGTH_BUDGET_CHAR_CAP[directive.lengthBudget];
    if (text.length > Math.floor(cap * LENGTH_TOLERANCE_MULTIPLIER)) {
      out.push({ kind: 'length-exceeded', cap, actual: text.length });
    }

    // Scan B: forbidden tokens. Compact-whitespace normalize both sides
    // (per feedback_cjk_compact_whitespace_match). Defensive double-apply
    // on tok is cheap (validateDirective already normalized, but the helper
    // normalizes input internally — caller may have hand-built a Directive
    // in tests).
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
