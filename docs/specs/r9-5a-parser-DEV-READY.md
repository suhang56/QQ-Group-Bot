# R9.5a — Planner timeout fix + fellBackReason distinguisher — DEV-READY

> Phase: R9.5a / Architect / 2026-05-05
> Worktree: `.claude/worktrees/r9-5a-parser/` on `feat/r9-5a-parser-harden`
> Branch base: master `9e7428a` (HEAD == base; worktree byte-identical to base
>   except for two new untracked spec docs and the gitignored audit-findings.md).
> Upstream: PLAN at `docs/specs/r9-5a-parser-PLAN.md` (LOCKED) +
>   DESIGN at `docs/specs/r9-5a-parser-DESIGN.md` (LOCKED).
> Audit input: `data/eval/r9-5a-audit/audit-findings.md` (n=112).

## §0 Architect resolutions to Designer §10 open questions

### Q1 — Option α (tagged result) vs Option β (typed exception)

**Architect picks Option β** (Designer recommended; Architect verified).

Rationale, grounded in real source state at `9e7428a`:

1. The current `Promise.race` arm at `reply-planner.ts:631-637` already uses
   the `setTimeout(reject)` style (rejects with `new Error('reply-planner timeout/abort')`).
   Switching the rejector to `new PlannerTimeoutError()` is a 1-line swap that
   inherits all existing race semantics. Option α (tagged result) would require
   restructuring the catch into a finally + sentinel-flag pair AND changing
   the public return type from `Promise<Directive | null>` to a tagged union,
   which cascades into 3 existing test sites (T2, T4, T10) and the chat.ts
   wire-site at line 3219 (`planned: Directive | null`). Option β preserves the
   contract.
2. Honors `feedback_metadata_on_result_not_side_channel`: the timeout signal
   rides on the typed exception itself, no parallel-Map lookup needed.
3. Honors `feedback_control_signal_shared_util_module`: `PlannerTimeoutError`
   exported from `reply-planner.ts` is consumed via named import in
   `chat.ts` — same module already exports `R9_PLANNER_TIMEOUT_MS`.
4. `instanceof` works in single-process tsx/vitest (this codebase) — no
   cross-realm boundary issues.

### Q2 — Lock comment on `R9_PLANNER_TIMEOUT_MS` or single-line const swap

**Architect picks: land the lock comment.**

Rationale: per `feedback_dont_let_specs_revise_against_shipped_commits` and
`feedback_check_output_origin_before_prescribing_fix` — the next agent
who sees `R9_PLANNER_TIMEOUT_MS = 1500` and wonders "why not 1000? why not
2000?" must be able to find the audit basis without spelunking. The 4-line
JSDoc embeds the audit p95/max + reference to DESIGN §1.1 and audit-findings.md.

### Q3 — `.gitignore` mirror entry

**Architect verified**: `data/eval/r9-5a-audit/audit-findings.md` IS currently
gitignored by the top-level `data/` rule at `.gitignore:3`. The `!data/eval/`
exception at line 12 only un-ignores the directory entry itself for traversal —
files inside still match the `data/` rule unless explicitly un-ignored.
`git check-ignore -v` confirms: `.gitignore:3:data/  data/eval/r9-5a-audit/audit-findings.md`.

**Add a single exception line** to commit only the curated findings file (NOT
raw run artifacts):

```
!data/eval/r9-5a-audit/audit-findings.md
```

This pattern mirrors the existing `!data/eval/gold/` style: directory-level
exception followed by explicit re-ignore of bulky artifacts. We do NOT
un-ignore the whole `data/eval/r9-5a-audit/` directory because raw
`run-*/replay-output.jsonl` and `runner.log` MUST stay gitignored (they are
large and easily regenerated).

## §1 Pinned line numbers (verified against HEAD `9e7428a`)

| File | Line | Anchor |
|------|------|--------|
| `src/modules/reply-planner.ts` | 26 | `export const R9_PLANNER_TIMEOUT_MS = 800;` |
| `src/modules/reply-planner.ts` | 631-637 | `abortPromise = new Promise<never>((_resolve, reject) => { ... reject(new Error('reply-planner timeout/abort')) })` |
| `src/modules/reply-planner.ts` | 639-652 | `let raw: string; try { ... } catch (err) { ... return null; } finally { ... }` |
| `src/modules/chat.ts` | 76-88 | planner-import group from `./reply-planner.js` |
| `src/modules/chat.ts` | 82 | `R9_PLANNER_TIMEOUT_MS,` |
| `src/modules/chat.ts` | 3215 | `setTimeout(() => controller.abort(), R9_PLANNER_TIMEOUT_MS)` |
| `src/modules/chat.ts` | 3217-3225 | `let planned: Directive \| null = null; try { planned = await this.replyPlanner!.plan(...) } catch (err) { ... fellBackReason = 'timeout'; } finally { ... }` |
| `src/modules/chat.ts` | 3241 | `if (fellBackReason === null) fellBackReason = planned === null ? 'parse' : 'validate';` |
| `test/modules/reply-planner.test.ts` | 2-15 | imports |
| `test/modules/reply-planner.test.ts` | 425-432 | T2 D-1 timeout returns null |
| `test/modules/reply-planner.test.ts` | 498-500 | constant default test (asserts 800) |
| `.gitignore` | 13-23 | eval-data ignore block |

Lines verified by Architect via Grep + Read against current worktree HEAD.

## §2 Verbatim diff plan

### §2.1 EDIT `src/modules/reply-planner.ts`

#### §2.1.a Const swap + lock comment (line 24-26)

**Before** (lines 24-27):

```ts
// ─── Constants (LOCKED per DESIGN §0 / DEV-READY §1A) ───────────────────
export const R9_PLANNER_MODEL = 'gemini-2.5-flash';
export const R9_PLANNER_TIMEOUT_MS = 800;
export const R9_PLANNER_MAX_TOKENS = 256;
```

**After**:

```ts
// ─── Constants (LOCKED per DESIGN §0 / DEV-READY §1A) ───────────────────
export const R9_PLANNER_MODEL = 'gemini-2.5-flash';
/**
 * LOCKED per R9.5a-DESIGN §1.1 — bumped 800ms to 1500ms after audit
 * (data/eval/r9-5a-audit/audit-findings.md) showed Gemini Flash p50=1065ms,
 * p95=1321ms, max=1472ms over n=112 R9-active rows. The previous 800ms cap
 * admitted only 1/112 (0.89%) of legitimate responses — the misattributed
 * cause of the 0.9% parse rate observed in r9-4-rebaseline-2026-05-05.md.
 * 1500ms covers 100% with ~28ms headroom over observed max.
 */
export const R9_PLANNER_TIMEOUT_MS = 1500;
export const R9_PLANNER_MAX_TOKENS = 256;
```

#### §2.1.b NEW export — `PlannerTimeoutError` class

Insert AFTER the `Constants` block (after the new line 35-ish) and BEFORE
the `// ─── Types ───` divider currently at line 29 (will shift after JSDoc
insertion). Developer pins the exact insertion point at edit time — anywhere
in the top-of-file exports block before `Types` is acceptable; recommended
just BEFORE the `// ─── Types ──────────────────────────────────────────────`
divider so it groups with other module-level exports.

**Add**:

```ts
/**
 * Sentinel thrown by the inner Planner timer arm when the per-call
 * R9_PLANNER_TIMEOUT_MS cap fires before the LLM responds. The wire site
 * at chat.ts catches this via instanceof and stamps fellBackReason='timeout'.
 * Per R9.5a-DESIGN §1.2 (audit found timeout was misattributed as 'parse'
 * because the inner catch swallowed the abort and returned null, collapsing
 * timeout and parse-fail onto the same null signal).
 */
export class PlannerTimeoutError extends Error {
  constructor() {
    super('reply-planner timeout');
    this.name = 'PlannerTimeoutError';
  }
}
```

#### §2.1.c `abortPromise` rejector swap (line 631-637)

**Before** (lines 631-637):

```ts
    const abortPromise = new Promise<never>((_resolve, reject) => {
      localController.signal.addEventListener(
        'abort',
        () => reject(new Error('reply-planner timeout/abort')),
        { once: true },
      );
    });
```

**After**:

```ts
    const abortPromise = new Promise<never>((_resolve, reject) => {
      localController.signal.addEventListener(
        'abort',
        () => reject(new PlannerTimeoutError()),
        { once: true },
      );
    });
```

#### §2.1.d `plan()` catch — distinguish + rethrow (line 639-652)

**Before** (lines 639-652):

```ts
    let raw: string;
    try {
      const resp = await Promise.race([completePromise, abortPromise]);
      raw = resp.text;
    } catch (err) {
      this.logger.debug(
        { err: String(err), durationMs: this.now() - start, groupId: ctx.groupId },
        'reply-planner LLM call failed (fail-open)',
      );
      return null;
    } finally {
      clearTimeout(timeoutTimer);
      signal.removeEventListener('abort', onParentAbort);
    }
```

**After**:

```ts
    let raw: string;
    try {
      const resp = await Promise.race([completePromise, abortPromise]);
      raw = resp.text;
    } catch (err) {
      if (err instanceof PlannerTimeoutError) {
        this.logger.debug(
          { durationMs: this.now() - start, groupId: ctx.groupId },
          'reply-planner timeout (fail-open)',
        );
        clearTimeout(timeoutTimer);
        signal.removeEventListener('abort', onParentAbort);
        throw err;
      }
      this.logger.debug(
        { err: String(err), durationMs: this.now() - start, groupId: ctx.groupId },
        'reply-planner LLM call failed (fail-open)',
      );
      return null;
    } finally {
      clearTimeout(timeoutTimer);
      signal.removeEventListener('abort', onParentAbort);
    }
```

**Architect note on the `finally` interaction**: Re-throwing inside the `catch`
still runs `finally` afterward — `clearTimeout` and `removeEventListener`
would run twice in the timeout-rethrow path (once in the explicit pre-throw
cleanup, once in finally). Both ops are idempotent: `clearTimeout` on an
already-fired timer is a no-op, `removeEventListener` for an already-removed
listener is a no-op. Developer MAY omit the explicit pre-throw cleanup if
preferred (the `finally` will handle it). Either is acceptable; the explicit
cleanup just makes intent clear. **Recommended**: keep the explicit cleanup
for readability, accept the redundant idempotent ops.

**Simpler alternative** (Developer's choice — both compile and test
identically): drop the pre-throw cleanup, let `finally` do all of it:

```ts
    let raw: string;
    try {
      const resp = await Promise.race([completePromise, abortPromise]);
      raw = resp.text;
    } catch (err) {
      if (err instanceof PlannerTimeoutError) {
        this.logger.debug(
          { durationMs: this.now() - start, groupId: ctx.groupId },
          'reply-planner timeout (fail-open)',
        );
        throw err; // bubble to chat.ts wire-site for fellBackReason='timeout'
      }
      this.logger.debug(
        { err: String(err), durationMs: this.now() - start, groupId: ctx.groupId },
        'reply-planner LLM call failed (fail-open)',
      );
      return null;
    } finally {
      clearTimeout(timeoutTimer);
      signal.removeEventListener('abort', onParentAbort);
    }
```

**Architect strong preference: simpler alternative.** The `finally` is the
single source of cleanup; the rethrow propagates after `finally` runs (per
JS spec). This is also what DESIGN §6 sketched. Develop the simpler version.

### §2.2 EDIT `src/modules/chat.ts`

#### §2.2.a Add `PlannerTimeoutError` to the planner-import group (line 76-88)

**Before** (lines 76-88):

```ts
import {
  buildFallbackDirective,
  validateDirective,
  assembleDirectiveBlock,
  extractTopTokens,
  directiveToJson,
  R9_PLANNER_TIMEOUT_MS,
  type Directive,
  type DirectiveMode,
  type DirectiveLengthBudget,
  type IReplyPlanner,
  type PlannerContext,
} from './reply-planner.js';
```

**After**:

```ts
import {
  buildFallbackDirective,
  validateDirective,
  assembleDirectiveBlock,
  extractTopTokens,
  directiveToJson,
  R9_PLANNER_TIMEOUT_MS,
  PlannerTimeoutError,
  type Directive,
  type DirectiveMode,
  type DirectiveLengthBudget,
  type IReplyPlanner,
  type PlannerContext,
} from './reply-planner.js';
```

#### §2.2.b Wire-site catch — narrow on PlannerTimeoutError (line 3217-3225)

**Before** (lines 3217-3225):

```ts
      let planned: Directive | null = null;
      try {
        planned = await this.replyPlanner!.plan(plannerCtx, controller.signal);
      } catch (err) {
        this.logger.debug({ err: String(err), groupId }, 'r9 planner threw — fallback');
        fellBackReason = 'timeout';
      } finally {
        clearTimeout(timeoutTimer);
      }
```

**After**:

```ts
      let planned: Directive | null = null;
      try {
        planned = await this.replyPlanner!.plan(plannerCtx, controller.signal);
      } catch (err) {
        if (err instanceof PlannerTimeoutError) {
          fellBackReason = 'timeout';
        } else {
          this.logger.debug({ err: String(err), groupId }, 'r9 planner threw — fallback');
          fellBackReason = 'timeout';
        }
      } finally {
        clearTimeout(timeoutTimer);
      }
```

**Architect note on the unknown-error branch**: keeping `'timeout'` for
unknown errors preserves backward compatibility with the pre-fix label —
that path already stamped `'timeout'` for any throw, and we do not have a
distinct error class for "unknown LLM exception" (the inner catch returns
null for those, so they don't reach this catch in practice). Only
`PlannerTimeoutError` is the typed-known case.

The downstream attribution effect:

- `'timeout'` (typed): inner cap aborted before LLM responded.
- `'timeout'` (untyped): a throw escaped the inner catch — should not happen
  in practice given current code; if it does, surfaces in debug log.
- `'parse'` (line 3241 unchanged): `planned === null` AND no throw → LLM
  responded but `tolerantParseDirective` returned null.
- `'validate'` (line 3241 unchanged): `planned !== null` AND `validateDirective`
  returned null.

### §2.3 EDIT `.gitignore`

**Before** (lines 11-23):

```
# R6.1 evaluation data (local-only, group chat history not committed)
!data/eval/
data/eval/*.jsonl
data/eval/*.json
# R6.2 gold-label output (un-ignore the subdir so git doesn't refuse mkdir, ignore jsonl within)
!data/eval/gold/
data/eval/gold/*.jsonl

# R6.3 replay-runner output (gitignored; owner-runner regenerates post-merge)
!data/eval/replay/
data/eval/replay/*.jsonl
data/eval/replay/*.json
data/eval/replay/.tmp/
```

**After** (insert a new block before the SQLite block at line 25):

```
# R6.1 evaluation data (local-only, group chat history not committed)
!data/eval/
data/eval/*.jsonl
data/eval/*.json
# R6.2 gold-label output (un-ignore the subdir so git doesn't refuse mkdir, ignore jsonl within)
!data/eval/gold/
data/eval/gold/*.jsonl

# R6.3 replay-runner output (gitignored; owner-runner regenerates post-merge)
!data/eval/replay/
data/eval/replay/*.jsonl
data/eval/replay/*.json
data/eval/replay/.tmp/

# R9.5a Planner audit findings (curated MD committed; raw run artifacts gitignored)
!data/eval/r9-5a-audit/audit-findings.md
```

### §2.4 NEW file — `data/eval/r9-5a-audit/audit-findings.md`

Already authored on this branch by Designer at
`D:/QQ-Group-Bot/.claude/worktrees/r9-5a-parser/data/eval/r9-5a-audit/audit-findings.md`
(verified by Architect: 8204 bytes, 8 sections, includes audit method, headline
finding, latency distribution, shape distribution, structural sample,
failure-mode table, audit-instrumentation fate, scope implication).

Developer just needs to `git add -f data/eval/r9-5a-audit/audit-findings.md`
after the `.gitignore` edit lands (the `-f` is a safety belt; with the new
exception line the bare add should also succeed — Developer verifies via
`git check-ignore -v` after editing `.gitignore`).

### §2.5 EDIT existing tests in `test/modules/reply-planner.test.ts`

Two existing tests must update to the new contract.

#### §2.5.a Update T2 (line 425-432) — timeout now THROWS instead of returning null

**Before**:

```ts
  it('T2 D-1: timeout returns null', async () => {
    const claude = makeClaudeStub('never');
    const planner = new ReplyPlanner(claude, createLogger('test-rp'), { timeoutMs: 30 });
    const ctx = makeBaseCtx();
    const ctrl = new AbortController();
    const result = await planner.plan(ctx, ctrl.signal);
    expect(result).toBeNull();
  });
```

**After**:

```ts
  it('T2 D-1: timeout throws PlannerTimeoutError (fellBackReason distinguisher)', async () => {
    const claude = makeClaudeStub('never');
    const planner = new ReplyPlanner(claude, createLogger('test-rp'), { timeoutMs: 30 });
    const ctx = makeBaseCtx();
    const ctrl = new AbortController();
    await expect(planner.plan(ctx, ctrl.signal))
      .rejects.toBeInstanceOf(PlannerTimeoutError);
  });
```

(Add `PlannerTimeoutError` to the imports at line 2-15 — see §2.5.c.)

#### §2.5.b Update constant default test (line 498-500)

**Before**:

```ts
  it('respects R9_PLANNER_TIMEOUT_MS constant default', () => {
    expect(R9_PLANNER_TIMEOUT_MS).toBe(800);
  });
```

**After**:

```ts
  it('respects R9_PLANNER_TIMEOUT_MS constant default', () => {
    expect(R9_PLANNER_TIMEOUT_MS).toBe(1500);
  });
```

#### §2.5.c Add `PlannerTimeoutError` to imports (line 2-15)

**Before**:

```ts
import {
  ReplyPlanner,
  validateDirective,
  buildFallbackDirective,
  tolerantParseDirective,
  extractTopTokens,
  assembleDirectiveBlock,
  directiveToJson,
  R9_PLANNER_TIMEOUT_MS,
  type ValidateContext,
  type FallbackSeed,
  type PlannerContext,
  type Directive,
} from '../../src/modules/reply-planner.js';
```

**After**:

```ts
import {
  ReplyPlanner,
  validateDirective,
  buildFallbackDirective,
  tolerantParseDirective,
  extractTopTokens,
  assembleDirectiveBlock,
  directiveToJson,
  R9_PLANNER_TIMEOUT_MS,
  PlannerTimeoutError,
  type ValidateContext,
  type FallbackSeed,
  type PlannerContext,
  type Directive,
} from '../../src/modules/reply-planner.js';
```

### §2.6 NEW tests appended to `test/modules/reply-planner.test.ts`

Append a new `describe` block at end of file (after line 501 closing brace):

```ts
describe('reply-planner — R9.5a timeout fix + real-Gemini fixture (audit-derived)', () => {
  it('T-AUDIT-1: real Gemini-2.5-Flash fenced output parses (audit-derived from groupId 958751334)', () => {
    // Verbatim sample shape from data/eval/r9-5a-audit/audit-findings.md §5
    // (canonical snake_case, fence-wrapped, all 6 fields). Assertion is on
    // the parse + validate pipeline that already exists; this test pins the
    // shape that the audit observed in 112/112 (100%) of R9-active rows.
    const raw = '```json\n{\n'
              + '  "mode": "reply",\n'
              + '  "length_budget": "short",\n'
              + '  "required_fact_ids": [],\n'
              + '  "forbidden_tokens": ["说啥", "你谁"],\n'
              + '  "tone_hint": "像一个被表白了有点不知所措的群友",\n'
              + '  "use_sticker_token": true\n'
              + '}\n```';
    const parsed = tolerantParseDirective(raw);
    expect(parsed).not.toBeNull();
    const d = validateDirective(parsed, makeValidateCtx({ stickerAllowed: true }));
    expect(d).not.toBeNull();
    expect(d!.mode).toBe('reply');
    expect(d!.lengthBudget).toBe('short');
    expect(d!.useStickerToken).toBe(true);
  });

  it('T-AUDIT-2: PlannerTimeoutError is exported and extends Error', () => {
    const e = new PlannerTimeoutError();
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(PlannerTimeoutError);
    expect(e.name).toBe('PlannerTimeoutError');
    expect(e.message).toBe('reply-planner timeout');
  });

  it('T-AUDIT-3: parse-fail (LLM returns garbage) returns null, NOT PlannerTimeoutError', async () => {
    const claude = makeClaudeStub('resolve', 'this is not json at all');
    const planner = new ReplyPlanner(claude, createLogger('test-rp'), { timeoutMs: 5000 });
    const ctx = makeBaseCtx();
    const ctrl = new AbortController();
    const result = await planner.plan(ctx, ctrl.signal);
    // parse-fail path: returns null (backward-compatible signal). The wire
    // site distinguishes this from timeout via the absence of the throw.
    expect(result).toBeNull();
  });

  // ─── Edge tests (mandatory per feedback_edge_testing_soul) ───

  it('E1: cap boundary — LLM resolves under cap returns Directive, no timeout', async () => {
    const json = JSON.stringify({
      mode: 'reply',
      length_budget: 'short',
      required_fact_ids: [],
      forbidden_tokens: [],
      tone_hint: '随意',
      use_sticker_token: false,
    });
    // Stub resolves immediately (well under cap of 200ms)
    const claude = makeClaudeStub('resolve', json);
    const planner = new ReplyPlanner(claude, createLogger('test-rp'), { timeoutMs: 200 });
    const ctx = makeBaseCtx();
    const ctrl = new AbortController();
    const result = await planner.plan(ctx, ctrl.signal);
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('reply');
  });

  it('E2: cap boundary — LLM never resolves at small cap throws PlannerTimeoutError', async () => {
    const claude = makeClaudeStub('never');
    const planner = new ReplyPlanner(claude, createLogger('test-rp'), { timeoutMs: 20 });
    const ctx = makeBaseCtx();
    const ctrl = new AbortController();
    await expect(planner.plan(ctx, ctrl.signal))
      .rejects.toBeInstanceOf(PlannerTimeoutError);
  });

  it('E3: external AbortController fires before timer also throws PlannerTimeoutError', async () => {
    // External abort path: caller aborts the signal before the inner timer
    // fires. The local controller's onParentAbort listener calls
    // localController.abort(), which fires the abortPromise rejector with
    // PlannerTimeoutError. Per DESIGN §1.4 E3: chat.ts does not currently
    // differentiate external-abort from internal-timeout; both fail-open as
    // 'timeout'. This test pins that unified behavior.
    const claude = makeClaudeStub('never');
    const planner = new ReplyPlanner(claude, createLogger('test-rp'), { timeoutMs: 5000 });
    const ctx = makeBaseCtx();
    const ctrl = new AbortController();
    // Abort externally before timer fires.
    setTimeout(() => ctrl.abort(), 10);
    await expect(planner.plan(ctx, ctrl.signal))
      .rejects.toBeInstanceOf(PlannerTimeoutError);
  });
});
```

**Architect note on test scope**: Designer's brief mentioned a separate
`test/integration/r9-5a-fellback-reason.test.ts` for chat.ts wire-path
assertions (T-4..T-6). Architect surveyed `test/integration/` and found no
existing chat.ts integration test that mocks the Planner end-to-end at the
chat.ts level — building one would require mocking `chat.ts`'s entire
construction graph (LLM, DB, persona, engagement decision, etc.), which is
a multi-hundred-LOC fixture and out-of-scope for a 5-LOC fellBackReason
attribution fix.

**Architect decision**: drop the chat.ts integration test file. The
attribution wiring at `chat.ts:3220-3225` is a 6-line `instanceof` check;
its correctness is verified by:

1. Unit tests above (T2, T-AUDIT-2, E2, E3) prove `PlannerTimeoutError`
   propagates out of `plan()`.
2. The chat.ts catch is mechanically straightforward — `instanceof X` is
   well-trodden language semantics.
3. Reviewer's real-LLM 781-row replay (acceptance gate §3) WILL exercise
   the full path end-to-end with real timeout signal and will log the
   `fellBackReason` distribution; if the wire-site is broken, reviewer
   sees `fellBackReason='timeout'` count = 0 alongside high rule-fallback,
   which fails the ≥95% parse-rate gate and surfaces immediately.

The integration test would re-prove what the real-LLM replay proves with
real cost. Skipping it honors `feedback_pr_success_is_user_bug_fixed_not_spec_met`
in reverse — don't add scaffolding that the acceptance gate already covers.

If Reviewer's 781-row replay reveals the wire-site is wrong (timeout count
0 with high fallback), it's a cheap loop-back to add the integration test.

## §3 Iteration Contract

| File | Change | Size estimate |
|------|--------|---------------|
| `src/modules/reply-planner.ts` | const + lock JSDoc + PlannerTimeoutError export + race rejector swap + catch rethrow | +22 / -2 LOC |
| `src/modules/chat.ts` | import addition + instanceof narrowing | +3 / -1 LOC |
| `.gitignore` | exception line + section comment | +3 LOC |
| `test/modules/reply-planner.test.ts` | T2 update + constant test update + import addition + 6 new tests (T-AUDIT-1/2/3 + E1/E2/E3) | +110 / -3 LOC |
| `data/eval/r9-5a-audit/audit-findings.md` | (already authored by Designer; just commit) | +198 LOC |
| `docs/specs/r9-5a-parser-DESIGN.md` | (Designer DONE; just commit) | +627 LOC |
| `docs/specs/r9-5a-parser-DEV-READY.md` | (this file; commit) | +500 LOC |
| **Total code-side** | | ~140 LOC |
| **Total docs-side** | | ~1325 LOC |

### Acceptance gates (Developer-side)

- `cd D:/QQ-Group-Bot/.claude/worktrees/r9-5a-parser && npx tsc --noEmit` → 0 errors
- All 6 new tests pass + 2 modified tests pass (T2, constant default)
- Full `vitest` no NEW regressions vs master `9e7428a` baseline
- ASCII single-quote scan empty (`grep -P '[\x{2018}\x{2019}\x{201C}\x{201D}]'` over modified files returns nothing)
- No `.claude/` paths in commit
- No Co-Authored-By line in commit message
- Single commit, conventional format. Recommended subject:
  ```
  fix(reply): R9.5a Planner timeout 800ms→1500ms + distinguish timeout vs parse fellBackReason
  ```
  Body should reference the audit (n=112, p95=1321ms, max=1472ms), the root
  cause (timeout misattributed as 'parse' due to inner catch swallowing),
  and link to DESIGN §1.1/§1.2 + audit-findings.md.
- Push to `origin/feat/r9-5a-parser-harden` after commit.
- Open PR (do NOT auto-merge). PR body: copy commit body + reference task #40
  + audit numbers.

### Acceptance gates (Reviewer-side, for §4)

See §4 below.

## §4 Reviewer audit hooks

Per Designer DESIGN §3 + this brief:

### §4.1 Mandatory checks

1. Re-run `tsc --noEmit` → 0 errors.
2. Re-run all 6 new tests + 2 modified tests → all pass.
3. Re-run full `vitest` → no NEW regressions vs master `9e7428a` baseline.
   - **Worktree caveat per `feedback_worktree_fixture_file_absence`**: any
     pre-existing flaky test or fixture-absence behavior on the worktree
     should be checked against base before being attributed to R9.5a.
4. ASCII quote scan over the 4 modified files (`src/modules/reply-planner.ts`,
   `src/modules/chat.ts`, `test/modules/reply-planner.test.ts`, `.gitignore`)
   → no smart quotes.
5. spec-to-impl 1:1 walkthrough: every line in §2.1-§2.6 above maps to a
   diff hunk in the commit; nothing extra.
6. `git log -1 --format=%B` → commit message matches conventional format,
   no Co-Authored-By, no `.claude/` paths.
7. `git ls-files` over the commit → no `.claude/` files.

### §4.2 Real-LLM 781-row replay (PRIMARY acceptance gate)

Run on `feat/r9-5a-parser-harden` HEAD with:

- `R9_REPLYER_LITE_ENABLED=1`
- `CHAT_MODEL=gemini-2.5-flash`
- NO `R9_PLANNER_AUDIT_RAW` (audit hook is gone, but the env-flag check is too)
- Slice: `benchmark-original-781`
- Cost cap: $5 (re-baseline cost was $0.149 — 1500ms cap should be similar)

Log Reviewer should pull from the replay output:

- `plannerSource` distribution: `llm-planner` / `rule-fallback` / `no-planner-skipped`
- `fellBackReason` distribution: `timeout` / `parse` / `validate` / `flag-off` / `bot-self` / `scope-skipped`
- p50, p95, max of `plannerLatencyMs` for the `llm-planner` rows

### §4.3 APPROVED gate criteria

**MUST pass (PRIMARY)**:

- Parse rate `llm-planner / (llm-planner + rule-fallback)` ≥ **95%** of
  R9-active rows. (Audit reality is 100%; 95% is slack for Gemini latency
  drift.)
- `rule-fallback` ≤ **5%** of R9-active rows.
- `tsc` clean.
- All new + modified tests pass.
- Full vitest no new regressions.

**SIDE OBSERVATIONS (logged, NOT blockers)**:

- Timeout count post-fix: should be ≤5% of R9-active rows. If higher,
  surface as a follow-up — Gemini latency drift or regional issue. **Not
  a blocker for this PR.**
- `fact-needed-no-fact` count post-fix: REPORTED but NOT a blocker. Task #43
  owns that metric.
- `direct-at-silenced` cluster count: per DESIGN §4, expected to revert
  toward pre-R9 baseline (~42). Reviewer flags the number in the report
  but does NOT block on it. Task #43 will use it to decide R9.5/R9.6 fate.

**NOT a gate**: reply-text quality eval (R9.5a is structural-only); real-group
canary (R9.6 owns that).

### §4.4 Output

Save review to `.claude/code-reviews.md` per `feedback_code_review_log`.
Format: timestamp, branch, commit SHA, gates pass/fail, side-observation
table, APPROVED or change-request bullets.

If APPROVED, SendMessage team-lead with the parse rate %, rule-fallback %,
timeout %, and direct-at-silenced count. Team-lead opens PR (do NOT
auto-merge per `feedback_never_autonomous_merge_to_default_branch`).

## §5 Standing rules embedded for downstream agents

Quoted verbatim from team-lead R9.5a Architect briefing because pipeline
agents do not see memory directly (per `feedback_embed_standing_rules_in_agent_briefing`):

- ASCII single quotes only — NO smart quotes (per `feedback_no_smart_quotes`).
- No emojis. No Co-Authored-By. No `.claude/` paths in commits
  (per `feedback_no_coauthor` + `feedback_no_claude_on_github`).
- Edge tests mandatory (E1, E2, E3 in §2.6) per `feedback_edge_testing_soul`.
- Conventional commits (per CLAUDE.md + `feedback_commit_format`).
- Helpers normalize input internally (N/A here, no new helpers).
- Validator at every boundary (N/A here, validator unchanged).
- Bot is groupmate not assistant (N/A here, no prompt change).
- Metadata on result, no side-channel maps (Option β honors this — typed
  exception, no Map keyed by groupId).
- HTML/LLM selectors against real-site snapshot, not synthetic (T-AUDIT-1
  fixture is verbatim audit-captured shape, not synthetic).
- Don't push to GitHub until APPROVED + team-lead confirmation.
- Worktree cwd discipline per `feedback_worktree_cwd_drift_misroutes_commits`:
  Developer always `cd D:/QQ-Group-Bot/.claude/worktrees/r9-5a-parser`
  before any git command, OR uses `git -C <worktree>` explicitly.

## §6 Open questions

None. All three Designer §10 questions resolved in §0 above:

- Q1 → Option β (typed exception)
- Q2 → land lock comment (4-line JSDoc)
- Q3 → `.gitignore` exception line for `audit-findings.md` only (raw run
  artifacts stay gitignored)

If Developer hits an unexpected blocker (e.g. `tsc` error from import shape,
race-condition in tests, an edge-test that reveals an unforeseen behavior
mismatch), SendMessage team-lead BEFORE applying a workaround.
