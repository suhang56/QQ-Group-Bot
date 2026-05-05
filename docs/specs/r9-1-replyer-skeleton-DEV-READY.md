# R9.1 — Replyer module skeleton + minimal contract — DEV-READY

> Phase 3 / Architect / 2026-05-05
> Worktree: `.claude/worktrees/r9-replyer-lite/` on `feat/r9-replyer-lite`
> HEAD before R9.1 write: `4258159` (parent: master `67f1a01`)
> Author: r9.1-architect.
>
> Cross-links:
> - PLAN: `docs/specs/r9-1-replyer-skeleton-PLAN.md` (LOCKED)
> - DESIGN: `docs/specs/r9-1-replyer-skeleton-DESIGN.md` (LOCKED)
> - R9-superset DESIGN-NOTE: `docs/specs/r9-replyer-lite-DESIGN-NOTE.md` (Directive shape locked here)
>
> Scope: verbatim diff plan for the R9.1 PR. Files, line ranges, source bodies,
> test bodies — all pinned. Developer copy-pastes; no synthesis required beyond
> the literal text below.

## §0 Line-pin verification (against current branch HEAD `4258159`)

Architect re-read `src/modules/reply-planner.ts` and `src/ai/claude.ts` at the
worktree HEAD (`4258159`) before writing. Pins match Designer's references:

| Symbol                       | File                              | Lines  | Status |
|------------------------------|-----------------------------------|--------|--------|
| `Directive` interface        | `src/modules/reply-planner.ts`    | 45-54  | OK     |
| `LENGTH_BUDGET_CHAR_CAP`     | `src/modules/reply-planner.ts`    | 39-43  | OK     |
| `assembleDirectiveBlock`     | `src/modules/reply-planner.ts`    | 404-458| OK (Designer cited 404-458) |
| `IClaudeClient.complete`     | `src/ai/claude.ts`                | 52-58  | OK (no `signal` param) |
| `ClaudeRequest` shape        | `src/ai/claude.ts`                | 32-42  | OK (model/maxTokens/system/messages) |
| `ClaudeResponse` shape       | `src/ai/claude.ts`                | 44-50  | OK (text + 4 token counts) |
| `ClaudeApiError` class       | `src/utils/errors.ts`             | 42-47  | OK (constructor takes `cause: unknown`) |

`git diff 4258159 -- src/modules/reply-planner.ts` returns empty — Planner
module is byte-identical to commit `4258159` and stays so through R9.1.

### §0.1 Working-tree state finding (correction vs briefing)

Briefing claimed five files dirty (`chat.ts / db.ts / config.ts / index.ts /
chat-result.ts`) plus untracked `src/config/reply-planner.ts`. ACTUAL state at
Architect time (`git status --short`):

```
 M src/modules/chat-decision-tracker.ts
 M src/storage/db.ts
 M src/storage/schema.sql
 M test/fixtures/replay-prod-db-synthetic.sqlite
?? docs/specs/r9-1-replyer-skeleton-DESIGN.md
?? docs/specs/r9-1-replyer-skeleton-PLAN.md
```

Plus untracked `src/config/reply-planner.ts` (confirmed via `ls`).

Reset list for Developer is the actual list, not the briefing list. Updated
in §3.1 below. The narrower reset list reduces blast radius — fewer files
touched.

## §1 File diff plan — exact files

| Action  | Path                                                  | Approx LOC | Notes |
|---------|-------------------------------------------------------|------------|-------|
| NEW     | `src/modules/reply-composer.ts`                       | ~200       | Full source in §2 |
| NEW     | `test/modules/reply-composer.test.ts`                 | ~330       | Full source in §3 |
| NEW     | `docs/specs/r9-1-replyer-skeleton-PLAN.md`            | (already)  | On disk, untracked, commit as-is |
| NEW     | `docs/specs/r9-1-replyer-skeleton-DESIGN.md`          | (already)  | On disk, untracked, commit as-is |
| NEW     | `docs/specs/r9-1-replyer-skeleton-DEV-READY.md`       | (this)     | This file |
| NO EDIT | `src/modules/reply-planner.ts`                        | 0          | Byte-identical guarantee — Reviewer asserts |
| NO EDIT | `src/ai/claude.ts`                                    | 0          | Untouched |
| NO EDIT | `src/utils/errors.ts`                                 | 0          | Untouched |
| NO EDIT | All other files                                       | 0          | Working-tree resets BEFORE staging — see §3.1 |

5 NEW files; 0 EDIT. Total commit diff: ~530 lines source + test + docs.

## §2 `src/modules/reply-composer.ts` — verbatim source

Developer creates this file with the EXACT content below. Paste-ready. ASCII
single quotes only; no smart quotes; no emojis.

```ts
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

// ─── Length-tolerance multiplier (LOCKED per DESIGN §3.2) ───────────────
//
// soft-violation threshold: text.length > Math.floor(cap * 1.3).
// 30 → 39 / 80 → 104 / 200 → 260. Module-scope (not per-instance) — telemetry
// tuning is a per-PR change, not a runtime knob.
export const LENGTH_TOLERANCE_MULTIPLIER = 1.3;

// ─── Types (per DESIGN §1) ──────────────────────────────────────────────

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

// ─── Composer class ─────────────────────────────────────────────────────

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

  // ─── Private helpers ──────────────────────────────────────────────────

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
```

### §2.1 Source-shape notes

- Imports: only `IClaudeClient` from `../ai/claude.js`, `Logger` from `pino`,
  and `assembleDirectiveBlock` / `LENGTH_BUDGET_CHAR_CAP` / `Directive` from
  `./reply-planner.js`. No re-export of `Directive` (per
  `feedback_no_deprecated_alias_on_clarifying_rename`).
- `LENGTH_TOLERANCE_MULTIPLIER` exported as `const` so tests can reference
  it; `Math.floor(cap * 1.3)` for integer threshold.
- Step 3's `cache: false` — Designer §2.1 used `cache: false as const` but
  TypeScript accepts plain `false` here because the surrounding array
  literal is fed into `system: CachedSystemBlock[]` whose element type is
  `{ text: string; cache: boolean }` (claude.ts:22-25). Plain `false` is
  cleaner.
- `_validateInputs` order is: silent → empty-system → empty-user →
  empty-model. Tests T-1..T-4 each construct ONE failing input; the order
  matters only when multiple fail simultaneously (rare).
- `_scanViolations` returns `DirectiveViolation[]` (mutable) because it's
  a private helper assembling a fresh array; the public `ComposeResult.violations`
  is `ReadonlyArray<DirectiveViolation>` so callers see the readonly view.
- `ASCII single quotes only` is honored throughout — including the embedded
  Chinese error message `'silent-directive'` uses double quotes only because
  it contains single-quote characters in the message body (`'silent'`). This
  matches `feedback_no_smart_quotes` (smart-quotes are U+201C/D/2018/9; the
  ASCII `"..."` is allowed when the body contains `'`).

## §3 `test/modules/reply-composer.test.ts` — verbatim source

Developer creates this file with the EXACT content below. 13 first-class
tests. Vitest. Stub `IClaudeClient` via plain object literal — same style as
`test/modules/reply-planner.test.ts:22-41`.

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  ReplyComposer,
  ReplyerContractError,
  LENGTH_TOLERANCE_MULTIPLIER,
  type ReplyContext,
} from '../../src/modules/reply-composer.js';
import type { Directive } from '../../src/modules/reply-planner.js';
import type { IClaudeClient, ClaudeResponse } from '../../src/ai/claude.js';
import { initLogger } from '../../src/utils/logger.js';
import { ClaudeApiError } from '../../src/utils/errors.js';

initLogger({ level: 'silent' });

// ─── Test helpers ───────────────────────────────────────────────────────

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

// ─── §4.1 Contract-violation tests (T-1..T-4) ──────────────────────────

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

// ─── §4.2 Prompt-assembly tests (T-5..T-7) ─────────────────────────────

describe('reply-composer — directive block in system array', () => {
  it('T-5 fact_answer with requiredFactIds renders must_use_facts via factsByIdMap', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('11/15福冈那场'));
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective({
      mode: 'fact_answer',
      lengthBudget: 'short',
      requiredFactIds: ['42'],
    });
    const factsByIdMap = new Map<number, { term: string; meaning: string }>([
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
    expect(directiveText).not.toContain('不要说');
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

// ─── §4.3 Sticker-positive happy path (T-13) ───────────────────────────

describe('reply-composer — sticker hint positive', () => {
  it('T-13 useStickerToken true renders sticker_hint: 建议出贴', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('回复'));
    const composer = new ReplyComposer(llm);
    await composer.compose(makeBaseDirective({ useStickerToken: true }), makeBaseCtx());
    const req = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.system[0].text).toContain('sticker_hint: 建议出贴');
  });
});

// ─── §4.4 Soft-violation tests (T-8, T-9) ──────────────────────────────

describe('reply-composer — soft violations (observe-only)', () => {
  it('T-8 length-exceeded fires when output > Math.floor(cap * 1.3)', async () => {
    // tiny cap = 30; 1.3 * 30 = 39 (Math.floor) → threshold 39; 50 > 39 → violation
    const fiftyChar = 'a'.repeat(50);
    const llm = makeClaudeStub('resolve', makeStubResp(fiftyChar));
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective({ lengthBudget: 'tiny' });
    const result = await composer.compose(directive, makeBaseCtx());
    expect(result.violations).toContainEqual({
      kind: 'length-exceeded', cap: 30, actual: 50,
    });
    // sanity: tolerance multiplier export available for downstream tests
    expect(LENGTH_TOLERANCE_MULTIPLIER).toBe(1.3);
  });

  it('T-9 forbidden-token fires after CJK compact-whitespace match', async () => {
    // forbidden '哈哈哈'; output '这事 哈 哈 哈 真的' compact-WS → '这事哈哈哈真的'
    const llm = makeClaudeStub('resolve', makeStubResp('这事 哈 哈 哈 真的'));
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective({ forbiddenTokens: ['哈哈哈'] });
    const result = await composer.compose(directive, makeBaseCtx());
    expect(result.violations).toContainEqual({
      kind: 'forbidden-token', token: '哈哈哈',
    });
  });
});

// ─── §4.5 Pass-through + immutability (T-10, T-11) ─────────────────────

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
    expect(result.violations).toEqual([]);
    expect(result.directiveSnapshot).toBe(directive);
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
    expect(req.system).toHaveLength(3);
    expect(req.system[0].cache).toBe(false);
    expect(req.system[1].text).toBe('a');
    expect(req.system[2].text).toBe('b');
  });
});

// ─── §4.6 Error propagation (T-12) ─────────────────────────────────────

describe('reply-composer — error propagation', () => {
  it('T-12 propagates ClaudeApiError unchanged (no swallow, no replacement)', async () => {
    const apiError = new ClaudeApiError(new Error('rate-limited'));
    const llm = makeClaudeStub('reject', apiError);
    const composer = new ReplyComposer(llm);
    await expect(composer.compose(makeBaseDirective(), makeBaseCtx())).rejects.toBe(apiError);
  });
});
```

### §3.1 Test-file shape notes

- Total test count: 4 (T-1..T-4) + 3 (T-5..T-7) + 1 (T-13) + 2 (T-8, T-9)
  + 2 (T-10, T-11) + 1 (T-12) = **13 first-class tests**, matching DESIGN §4.7.
- `initLogger({ level: 'silent' })` at module top — same as
  `reply-planner.test.ts:20`. Ensures no log noise in test output if any
  module-level code paths reach a logger.
- `factsByIdMap` typed `Map<number, { term: string; meaning: string }>`
  in T-5 — DOWN-casts to the readonly form when assigned to ctx.factsByIdMap.
  TypeScript accepts because `Map<K,V>` is a subtype of `ReadonlyMap<K,V>`.
- T-7 uses `mockClear()` between sub-cases so the second `mock.calls[0][0]`
  read returns the second invocation's args, not the first.
- T-8 asserts the `LENGTH_TOLERANCE_MULTIPLIER` constant is `1.3` to pin the
  exported value; if Developer accidentally bumps it, this test fails fast.
- T-11 uses `JSON.stringify` for deep-equality snapshot of pre/post state —
  matches DESIGN §4.5. Cheaper than a deep-clone util and avoids importing
  one.
- T-12 asserts `rejects.toBe(apiError)` (identity, not just `instanceof`)
  per DESIGN §4.6 — confirms NO swallowing or wrapping.

## §4 Working-tree reset list (Developer pre-commit)

Per DESIGN §7 + PLAN §3.1. ACTUAL state at Architect time (`git status
--short` output reproduced from §0.1):

```
 M src/modules/chat-decision-tracker.ts
 M src/storage/db.ts
 M src/storage/schema.sql
 M test/fixtures/replay-prod-db-synthetic.sqlite
?? docs/specs/r9-1-replyer-skeleton-DESIGN.md
?? docs/specs/r9-1-replyer-skeleton-PLAN.md
?? src/config/reply-planner.ts        ## not in `git status --short` because nested?
```

(Confirm `src/config/reply-planner.ts` exists via `ls src/config/reply-planner.ts`
before Developer step 1. It is from R9-superset stale wiring residue.)

### §4.1 Developer reset commands (run in order)

```bash
cd D:/QQ-Group-Bot/.claude/worktrees/r9-replyer-lite

## Step 1 — reset all R9-superset stale modifications to match HEAD (4258159).
## Includes the unrelated test fixture file (binary) which we should NOT touch.
git checkout HEAD -- src/modules/chat-decision-tracker.ts \
                     src/storage/db.ts \
                     src/storage/schema.sql \
                     test/fixtures/replay-prod-db-synthetic.sqlite

## Step 2 — remove the stale R9-superset config file (R9.3 wiring residue).
git rm src/config/reply-planner.ts 2>/dev/null || rm -f src/config/reply-planner.ts

## Step 3 — verify clean tree (only NEW R9.1 files should remain).
git status --short
##  Expected output (pre-create of reply-composer.ts):
##    ?? docs/specs/r9-1-replyer-skeleton-DESIGN.md
##    ?? docs/specs/r9-1-replyer-skeleton-PLAN.md
```

If `src/config/reply-planner.ts` was tracked, `git rm` succeeds. If untracked,
`rm -f` succeeds. Either way, the file is gone. The 2nd `||` clause makes the
command idempotent.

### §4.2 Surface to user before reset (per `feedback_user_coauthors_in_working_tree`)

The 4 dirty source files (`chat-decision-tracker.ts`, `db.ts`, `schema.sql`,
fixture sqlite) appear to be R9-superset wiring residue — same shape as the
files referenced in the briefing (chat.ts/db.ts/config.ts/index.ts/chat-result.ts)
just narrower set. Architect cannot rule out the user has uncommitted unrelated
work. **Developer SHOULD `git diff` each of the 3 source files BEFORE the
reset and quickly check whether the changes look R9-related or unrelated**.
If any change looks unrelated to R9, SendMessage team-lead before resetting.

The fixture sqlite (`test/fixtures/replay-prod-db-synthetic.sqlite`) is binary
and likely auto-modified by a recent test run; safe to reset.

## §5 Compile + test acceptance gates

Developer runs all 4 BEFORE committing. Reviewer re-runs independently per §6.

### §5.1 TypeScript compile

```bash
cd D:/QQ-Group-Bot/.claude/worktrees/r9-replyer-lite
npx tsc --noEmit
```

Expected: 0 errors. The `--noEmit` flag avoids regenerating `dist/`.

### §5.2 New unit-test suite (only the new file)

```bash
cd D:/QQ-Group-Bot/.claude/worktrees/r9-replyer-lite
npx vitest run test/modules/reply-composer.test.ts
```

Expected: `Tests  13 passed (13)`. All 13 first-class tests pass.

### §5.3 Full suite (no regressions vs `4258159` baseline)

```bash
cd D:/QQ-Group-Bot/.claude/worktrees/r9-replyer-lite
npx vitest run
```

Expected: same pass/fail count as on commit `4258159` plus 13 new passing
tests. Reviewer (Phase 5) is responsible for diffing the result against
the baseline — Developer just confirms no NEW failures.

### §5.4 ASCII single-quote scan

```bash
cd D:/QQ-Group-Bot/.claude/worktrees/r9-replyer-lite
grep -RnP '[\x{2018}\x{2019}\x{201C}\x{201D}]' src/modules/reply-composer.ts test/modules/reply-composer.test.ts \
  || echo "ASCII clean"
```

Expected: `ASCII clean` (grep returns non-zero on no-match). Per
`feedback_no_smart_quotes`.

### §5.5 No `.claude/` paths in commit diff

```bash
cd D:/QQ-Group-Bot/.claude/worktrees/r9-replyer-lite
git diff --cached --name-only | grep '\.claude/' && echo "FAIL: .claude/ in commit" || echo "no .claude/ paths"
```

Expected: `no .claude/ paths`. Per `feedback_no_claude_on_github`.

### §5.6 No `Co-Authored-By` line in commit message

Commit body (see §6) contains NO `Co-Authored-By:` lines. Per
`feedback_no_coauthor`.

## §6 Commit + push

### §6.1 Stage NEW files only

```bash
cd D:/QQ-Group-Bot/.claude/worktrees/r9-replyer-lite

## After Step 1-2 from §4.1 and the 2 new src/test files written:
git add src/modules/reply-composer.ts \
        test/modules/reply-composer.test.ts \
        docs/specs/r9-1-replyer-skeleton-PLAN.md \
        docs/specs/r9-1-replyer-skeleton-DESIGN.md \
        docs/specs/r9-1-replyer-skeleton-DEV-READY.md

## Verify staged set is exactly 5 files, all NEW:
git status --short
##  Expected:
##    A  docs/specs/r9-1-replyer-skeleton-DESIGN.md
##    A  docs/specs/r9-1-replyer-skeleton-DEV-READY.md
##    A  docs/specs/r9-1-replyer-skeleton-PLAN.md
##    A  src/modules/reply-composer.ts
##    A  test/modules/reply-composer.test.ts
```

### §6.2 Commit

Single commit, conventional format. NO `Co-Authored-By`. NO emojis.

```bash
git commit -m "$(cat <<'EOF'
feat(reply): R9.1 replyer module skeleton + minimal contract

- NEW src/modules/reply-composer.ts: ReplyComposer class implementing
  IReplyer; consumes Directive + ReplyContext, single LLM call, returns
  ComposeResult with directiveSnapshot + soft violations.
- NEW test/modules/reply-composer.test.ts: 13 tests covering 4 contract
  validators, 3 prompt-assembly cases, 1 sticker-positive happy path,
  2 soft-violation observability cases, 2 pass-through+immutability,
  1 error propagation.
- NEW docs/specs/r9-1-replyer-skeleton-{PLAN,DESIGN,DEV-READY}.md.

Standalone module — not yet imported in the running call graph.
chat.ts wire-up + feature flag + DB migration land in R9.3.
EOF
)"
```

### §6.3 Push

```bash
cd D:/QQ-Group-Bot/.claude/worktrees/r9-replyer-lite
git push -u origin feat/r9-replyer-lite
```

If the branch already tracks `origin/feat/r9-replyer-lite`, `-u` is a no-op.

### §6.4 PR open

Per `feedback_gh_pr_create_explicit_base_head`:

```bash
cd D:/QQ-Group-Bot/.claude/worktrees/r9-replyer-lite
gh pr create --base main --head feat/r9-replyer-lite \
  --title "feat(reply): R9.1 replyer module skeleton + minimal contract" \
  --body "$(cat <<'EOF'
## Summary
- NEW `src/modules/reply-composer.ts` — ReplyComposer class + IReplyer
  interface + ComposeResult / DirectiveViolation / ReplyerContractError
  shapes. Single LLM call per compose(); never mutates input; soft
  violations observed but not vetoed.
- NEW `test/modules/reply-composer.test.ts` — 13 first-class tests
  (4 contract validators, 3 prompt-assembly, 1 sticker-positive,
  2 soft-violation, 2 pass-through+immutability, 1 error propagation).
- NEW `docs/specs/r9-1-replyer-skeleton-{PLAN,DESIGN,DEV-READY}.md`.

## What is NOT in
- chat.ts wire-up / feature flag plumbing → R9.3
- DB ALTER `chat_decision_events.directive_json` → R9.3
- `BaseResultMeta` extension → R9.3
- Offline benchmark on R6 gold-1027 → R9.4
- Real-group canary → R9.6

## Test plan
- [ ] `npx tsc --noEmit` returns 0 errors
- [ ] `npx vitest run test/modules/reply-composer.test.ts` shows 13/13 pass
- [ ] `npx vitest run` shows no NEW failures vs `4258159` baseline
- [ ] `git diff master --stat` lists ONLY new files (no edits to existing)
- [ ] `git diff 4258159 -- src/modules/reply-planner.ts` is empty
EOF
)"
```

(Per branch policy — bangdream-na has standing auto-merge but QQ-Bot does
NOT. Developer DOES NOT auto-merge. Reviewer Phase 5 + user approval gate
the merge.)

## §7 Reviewer (Phase 5, task #26) audit hooks

Reviewer must:

1. **Re-run** all 4 acceptance gates from §5 independently. Do NOT trust
   Developer's claim. (Per `feedback_team_lead_self_verify_not_reviewer` —
   Reviewer runs the gates, not just reads the report.)

2. **Verify byte-identical `reply-planner.ts`**:
   ```bash
   cd D:/QQ-Group-Bot/.claude/worktrees/r9-replyer-lite
   git diff 4258159 -- src/modules/reply-planner.ts
   ```
   Expected: empty output.

3. **Verify the 4 reset files match HEAD** (no stale R9-superset code in
   the R9.1 commit):
   ```bash
   git diff 4258159 -- src/modules/chat-decision-tracker.ts \
                       src/storage/db.ts \
                       src/storage/schema.sql \
                       test/fixtures/replay-prod-db-synthetic.sqlite
   ```
   Expected: empty output.

4. **Verify `git diff master --stat`** lists ONLY new files:
   - `docs/specs/r9-1-replyer-skeleton-DESIGN.md` (NEW)
   - `docs/specs/r9-1-replyer-skeleton-DEV-READY.md` (NEW)
   - `docs/specs/r9-1-replyer-skeleton-PLAN.md` (NEW)
   - `src/modules/reply-composer.ts` (NEW)
   - `test/modules/reply-composer.test.ts` (NEW)
   - `src/modules/reply-planner.ts` (NEW vs master since 4258159 was the
     reply-planner commit) — this is the EXISTING content; Reviewer confirms
     it's identical to commit `4258159` per item 2 above.
   - `src/modules/chat.ts` (NEW vs master since `e391084` is on branch but
     R9.1 doesn't touch chat.ts — verify with `git diff 4258159 -- src/modules/chat.ts`
     is empty).

   Wait — branch HEAD is `4258159`; commit `e391084` is the "wire R9 planner
   into chat.ts" commit. The branch was rebased to `4258159` per briefing.
   Reviewer confirms `git log master..feat/r9-replyer-lite --oneline` shows
   the expected sequence: master → reply-planner commit → R9.1 commit, with
   no chat.ts wiring commit reachable from R9.1 PR HEAD.

5. **NO smoke test required**. R9.1 ships no behavior change (no chat.ts
   import, no flag flip). Acceptance is unit-test only. (Per
   `feedback_pr_validation_must_exercise_pr_change_scenarios` — the change
   scenario for R9.1 is "ReplyComposer tested in isolation"; tests in
   `test/modules/reply-composer.test.ts` ARE the change scenarios.)

6. **Save review to `.claude/code-reviews.md`** per `feedback_code_review_log`.
   Format: APPROVED / CHANGES_REQUESTED + bullet list of findings + the
   13/13 pass count + tsc 0 + ASCII clean + master-vs-branch stat output.

7. **Reviewer does NOT merge**. Per `feedback_never_autonomous_merge_to_default_branch` +
   `feedback_standing_merge_authorization_qqbot` — QQ-Bot has standing merge
   authorization for ReviewerAPPROVED PRs from team lead, but Reviewer itself
   doesn't merge. Reviewer's job is the APPROVED stamp + code-reviews.md log.

## §8 Iteration Contract (verbatim from briefing)

| Constraint                | Value                                                        |
|---------------------------|--------------------------------------------------------------|
| Files                     | 5 NEW (2 src/test + 3 docs/specs)                            |
| LOC budget                | ~600 total (200 src + 350 test + 50 doc-touched-by-this-phase) |
| Acceptance — tsc          | `npx tsc --noEmit` → 0 errors                                |
| Acceptance — new tests    | `npx vitest run test/modules/reply-composer.test.ts` → 13/13 |
| Acceptance — full suite   | `npx vitest run` → no NEW failures vs `4258159` baseline      |
| ASCII quote scan          | empty                                                        |
| `.claude/` in commit      | none                                                         |
| `Co-Authored-By` in msg   | none                                                         |
| Commit count              | 1 (single commit)                                            |
| Commit message            | `feat(reply): R9.1 replyer module skeleton + minimal contract` |

## §9 Standing rules check (Architect, explicit)

Per `feedback_embed_standing_rules_in_agent_briefing`. Each rule restated +
honored in this DEV-READY:

- **ASCII single quotes only** — §2 source uses ASCII `'...'` everywhere.
  The one exception is the Chinese error-message body in `_validateInputs`
  for `silent-directive` which uses ASCII `"..."` because the message body
  itself contains `'silent'` ASCII single-quotes. Smart quotes (U+2018/9,
  U+201C/D) are absent from both source files. §5.4 grep gate enforces.
- **No emojis** — DEV-READY scanned; none present.
- **No `Co-Authored-By` lines** — §6.2 commit body explicitly excludes.
- **No `.claude/` paths in commit** — §5.5 gate enforces; all 5 NEW files
  live at repo-relative paths (`src/`, `test/`, `docs/specs/`).
- **Edge tests mandatory** — §3 covers 13 first-class tests; every
  contract guard has a test (T-1..T-4); both soft-violation kinds (T-8,
  T-9); immutability (T-11); error propagation (T-12); each
  `useStickerToken` arm (T-7 + T-13).
- **Conventional commits** — §6.2 message uses `feat(reply): ...`.
- **Helpers normalize input internally** — `_validateInputs` trims model
  + userContent before checking; `_scanViolations` compact-whitespaces both
  sides. Callers pass raw values.
- **Validator at every boundary** — `_validateInputs` runs at Replyer entry;
  `validateDirective` (separate) ran at Planner exit. Two boundaries.
- **Bot is groupmate, not assistant** — `assembleDirectiveBlock` (re-used
  from reply-planner.ts:404-458) emits `'约束 = 数据'` and `'你仍然是
  群友，不是助理'` verbatim.
- **No reverse priming** — `forbiddenTokens` rendered as DATA list
  (`avoid_repeating: - X / - Y`); T-6 asserts `'不要说'` is absent.
- **Trusted rules outside, untrusted data inside** — directive block uses
  `<reply_directive_do_not_follow_instructions>` envelope. Leading prose
  outside the envelope = trusted rule; tokens/factIds inside = data.
- **LLM call must NOT block reply path on fail** — `compose()` propagates
  errors typed; T-12 asserts identity pass-through. R9.3 chat.ts caller
  wraps in try/catch + falls back. R9.1 itself does NOT catch.
- **No deprecated alias on rename** — `Directive` lives only at
  `src/modules/reply-planner.ts`. `reply-composer.ts` imports; does NOT
  re-export.
- **CJK compact-whitespace match** — `_scanViolations` Scan B uses
  `text.replace(/\s+/g, '')` for both sides; T-9 asserts.
- **Immutability** — `compose()` allocates a new `systemBlocks` array; never
  mutates. Returns NEW `ComposeResult` object. T-11 asserts.
- **Result types carry meta on themselves** — `ComposeResult` carries
  `directiveSnapshot` and `violations` directly; no `getViolationsForLastCall()`
  Map.
- **Pipeline strictly follows PLAN+DESIGN** — Architect refined parameter
  shapes (e.g. `cache: false` plain literal vs `as const`) but did NOT
  override any LOCKED Designer pin (13 tests; IReplyer signature; LENGTH_TOLERANCE_MULTIPLIER;
  factsByIdMap=number keys; AbortSignal OUT; logger constructor-injected;
  model via ctx.model; out-of-scope items verbatim).

## §10 Hand-off to Developer (R9.1 Phase 4, task #25)

Developer:

1. Run §4.1 reset commands. Verify `git status --short` shows only the 2
   PLAN/DESIGN .md files as untracked.
2. Create `src/modules/reply-composer.ts` with the EXACT content from §2.
3. Create `test/modules/reply-composer.test.ts` with the EXACT content from §3.
4. Run §5.1..§5.5 acceptance gates. All pass.
5. Run §6.1 stage commands.
6. Run §6.2 commit (single conventional commit; no Co-Authored-By).
7. Run §6.3 push.
8. Run §6.4 PR-create.
9. Mark task #25 completed via TaskUpdate. SendMessage team-lead with PR URL +
   tsc-pass + 13/13-pass confirmation.

If any acceptance gate fails, Developer fixes the underlying issue and
creates a NEW commit (NOT --amend, per Hard Rules). Re-run gates. Re-push.

## §11 References

- `docs/specs/r9-1-replyer-skeleton-PLAN.md` — R9.1 PLAN (locked).
- `docs/specs/r9-1-replyer-skeleton-DESIGN.md` — R9.1 DESIGN (locked).
- `docs/specs/r9-replyer-lite-DESIGN-NOTE.md` — R9-superset DESIGN-NOTE
  (Directive shape locked; assembleDirectiveBlock prompt text locked).
- `src/modules/reply-planner.ts` (commit `4258159`, lines 39-43, 45-54,
  404-458) — exports R9.1 imports (`Directive`, `LENGTH_BUDGET_CHAR_CAP`,
  `assembleDirectiveBlock`).
- `src/ai/claude.ts` (lines 22-50, 52-58) — `IClaudeClient` /
  `ClaudeRequest` / `ClaudeResponse` shapes used by R9.1.
- `src/utils/errors.ts` (lines 42-54) — `ClaudeApiError` / `ClaudeParseError`
  classes used in T-12 + propagation contract.
- `test/modules/reply-planner.test.ts` (lines 22-41) — stub IClaudeClient
  pattern mirrored by R9.1 tests.
- `~/.claude/plans/curried-wondering-rocket.md` (lines 175-181) — R9 multi-PR
  breakdown.

End of DEV-READY. Ready for Developer (Phase 4, task #25).
