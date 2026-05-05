# R9.5a — Planner timeout fix + fellBackReason distinguisher — DESIGN

> Phase: R9.5a / Designer / 2026-05-05
> Worktree: `.claude/worktrees/r9-5a-parser/` on `feat/r9-5a-parser-harden`
> Branch base: master `9e7428a`
> Author: r9.5a-designer.
> Upstream: PLAN at `docs/specs/r9-5a-parser-PLAN.md` (Planner-locked).
> Audit input: `data/eval/r9-5a-audit/audit-findings.md` (this branch, n=112).
> Approved scope shift from team-lead 2026-05-05: Option A (timeout-only) +
> fellBackReason distinguisher + acceptance gate raised to ≥95%.

## §0 Audit summary (binding evidence)

The PLAN scope ("parser/prompt hardening to lift parse rate from 0.9% to ≥80%")
is invalidated by the audit. Replacing it with a tightly-scoped timeout fix
plus a `fellBackReason` truth-in-attribution patch.

Key numbers from `data/eval/r9-5a-audit/audit-findings.md`:

- 112/112 (100%) `parseOk=true` when LLM response received.
- 112/112 (100%) validator-clean (canonical snake_case schema, all fields).
- 112/112 (100%) shape: `\`\`\`json\n{...}\n\`\`\`` fenced, handled by existing
  `extractJson`.
- All 5 hunch failure modes from PLAN §4 (fence/prose/case/punct/unquoted/
  comments/null/empty) FALSIFIED in real Gemini Flash output for this prompt.
- Planner latency p50=1065ms, p75=1168ms, p90=1256ms, p95=1321ms, max=1472ms.
- Only **1/112 (0.89%) under the current 800ms cap** — exact match to the
  re-baseline's 0.9% "parse rate".

Mechanism of the mis-attribution:

1. `R9_PLANNER_TIMEOUT_MS = 800` aborts the inner LLM call before Gemini Flash
   responds in ~99% of R9-active rows.
2. `reply-planner.ts:643-651` catches the abort error, logs at debug, returns
   `null` to the caller.
3. `chat.ts:3241` sees `planned === null` and stamps
   `fellBackReason = 'parse'` because the only OUTER `'timeout'` branch
   (`chat.ts:3220-3225`) is for `replyPlanner.plan()` THROWING, which the
   inner catch swallows. The two distinct null-paths (timeout and
   parse-fail) collapse onto `'parse'`.

R9.5a-Designer recommendation = team-lead approval: fix at root.

## §1 In-scope changes (DESIGN-locked)

### §1.1 `R9_PLANNER_TIMEOUT_MS` 800 → 1500 (`reply-planner.ts:26`)

Change one line:

```ts
// before
export const R9_PLANNER_TIMEOUT_MS = 800;
// after
export const R9_PLANNER_TIMEOUT_MS = 1500;
```

Rationale (audit-bound):

| Cap   | Coverage of observed Gemini Flash responses (n=112) |
|-------|-----------------------------------------------------|
|  800ms | 1 / 112 (0.89%)  ← current                          |
| 1000ms | 37 / 112 (33.0%)                                    |
| 1200ms | 90 / 112 (≈80%)                                     |
| 1300ms | ≈107 / 112 (≈95%)                                   |
| 1500ms | 112 / 112 (100%, with ~30ms headroom over max 1472) |
| 2000ms | 112 / 112 (100%, with ~530ms slack)                 |

1500ms is the **smallest cap that covers 100% of observed responses with any
headroom**. Picking 1500 over 1300 because:

- p99 was 1395ms — 1300ms would clip the long tail (~5% of responses).
- 1500ms still leaves Replyer + downstream chat assembly comfortably under
  the practical 8-10s ceiling that user-facing latency can absorb.
- 2000ms is also fine but conservative; 1500 is the audit-grounded minimum.

Cross-reference: `R9_PLANNER_TIMEOUT_MS` is imported by `chat.ts:82` and used
at `chat.ts:3215` for the wire-site outer abort. The single-source-of-truth
constant means the wire-site cap moves with it automatically — no second
edit needed. This honors `feedback_control_signal_shared_util_module`.

### §1.2 `fellBackReason` distinguisher (timeout vs parse vs validate)

Today (per `reply-planner.ts:643-651` + `chat.ts:3220-3242`) the wire-site
sees only `Directive | null` from `plan()`. It cannot distinguish:

- **timeout**: inner abort fired, caller throws→catch returns null
- **parse**: LLM responded but `tolerantParseDirective` returned null
- **validate**: parse OK but `validateDirective` returned null

The old code stamps `'timeout'` only when `replyPlanner.plan()` itself throws
(line 3220-3225) — which it doesn't, because the inner catch swallows.

**Architect picks one of two implementation options** (DESIGN does not pin —
both are sound; pick smaller diff):

**Option α — Promise.race result inspector (in-place patch):**

In `reply-planner.ts:639-652`, replace the single `try { Promise.race ... }`
with a wrapped result that records which arm won:

```ts
// before
let raw: string;
try {
  const resp = await Promise.race([completePromise, abortPromise]);
  raw = resp.text;
} catch (err) {
  this.logger.debug({...}, 'reply-planner LLM call failed (fail-open)');
  return null;
}

// after (sketch)
let raw: string | null = null;
let timedOut = false;
try {
  const resp = await Promise.race([completePromise, abortPromise]);
  raw = resp.text;
} catch (err) {
  if (localController.signal.aborted) timedOut = true;
  this.logger.debug({...}, 'reply-planner LLM call failed (fail-open)');
} finally { /* unchanged */ }
if (raw === null) {
  return { ok: false, reason: timedOut ? 'timeout' : 'parse' } as const;
}
```

Pro: localized to reply-planner.ts.
Con: changes the Planner contract from `Directive | null` to a tagged
result, which means the caller in chat.ts must be updated. May cascade to
tests. Estimated diff: ~20 lines + test updates.

**Option β — sentinel error class (cleaner contract):**

Define `PlannerTimeoutError` exported from `reply-planner.ts`. Throw it
from the timer arm. Caller `chat.ts:3220-3225` adds an `instanceof` check:

```ts
// reply-planner.ts (new export)
export class PlannerTimeoutError extends Error {
  constructor() { super('reply-planner timeout'); this.name = 'PlannerTimeoutError'; }
}

// reply-planner.ts:631-637 (was)
const abortPromise = new Promise<never>((_resolve, reject) => {
  localController.signal.addEventListener(
    'abort',
    () => reject(new Error('reply-planner timeout/abort')),
    { once: true },
  );
});
// reply-planner.ts:631-637 (after)
const abortPromise = new Promise<never>((_resolve, reject) => {
  localController.signal.addEventListener(
    'abort',
    () => reject(new PlannerTimeoutError()),
    { once: true },
  );
});

// reply-planner.ts:640-652 (catch — keep return null for backward shape,
//   but rethrow the typed sentinel so caller can attribute)
try {
  const resp = await Promise.race([completePromise, abortPromise]);
  raw = resp.text;
} catch (err) {
  if (err instanceof PlannerTimeoutError) {
    this.logger.debug({...}, 'reply-planner timeout (fail-open)');
    throw err; // bubble — caller's outer catch attributes 'timeout'
  }
  this.logger.debug({...}, 'reply-planner LLM call failed (fail-open)');
  return null;
}

// chat.ts:3217-3225 — outer catch already exists; just narrow
try {
  planned = await this.replyPlanner!.plan(plannerCtx, controller.signal);
} catch (err) {
  if (err instanceof PlannerTimeoutError) {
    fellBackReason = 'timeout';
  } else {
    this.logger.debug({...}, 'r9 planner threw — fallback');
    fellBackReason = 'timeout'; // unchanged for non-typed errors
  }
}
```

Pro: tiny surface (1 export + 1 throw + 1 instanceof). The Planner contract
stays `Directive | null` for the parse/validate path. No test scaffolding
churn. Honors `feedback_metadata_on_result_not_side_channel` (the timeout
signal rides on a typed exception, not a side-channel Map keyed by groupId).

Con: relies on instanceof working across module boundaries (it does in
single-process tsx, so fine for this codebase).

Estimated diff: ~10 lines.

**Designer recommendation: Option β** — smaller diff, preserves Planner
contract, and the type signal rides on the error itself (no side-channel).
Architect can override to α if there's a reason I missed.

Either option achieves the same observable effect:

| `fellBackReason` value | When |
|------------------------|------|
| `'timeout'` | inner LLM call aborted by 1500ms cap before response |
| `'parse'`   | LLM responded but `tolerantParseDirective` returned null |
| `'validate'`| parse OK, `validateDirective` returned null |
| `'flag-off'` / `'bot-self'` / `'scope-skipped'` | unchanged |

Test-side: in `test/modules/reply-planner.test.ts` add 1 fixture (Option β)
that asserts `plan()` throws `PlannerTimeoutError` on the `never`-resolving
LLM stub; or (Option α) that the result tag includes `'timeout'`.

### §1.3 Strip audit hook from final PR

The two-part audit instrumentation in the worktree is investigative-only:

1. The `R9_PLANNER_AUDIT_RAW` env-gated info-level log block at
   `reply-planner.ts:655-674` (added by Designer during audit).
2. The temporary env-conditional `R9_PLANNER_TIMEOUT_MS` (already reverted to
   the new value 1500 in §1.1).

Both REMOVED before commit. The new code in §1.1 + §1.2 is the only diff
that ships. (The Designer's worktree file already has §1.1's old value 800
restored after the audit run; it just needs the new value 1500 written.)

If future re-audit is needed, the 5-line hook is trivial to re-add. Per
team-lead 2026-05-05 standing decision: clean exit.

### §1.4 Test additions (audit-derived, per PLAN §5 acceptance lock)

**File**: `test/modules/reply-planner.test.ts`

Add 3 tests, all with fixtures sourced from real audit raw text in
`data/eval/r9-5a-audit/run-1/runner.log`:

**T-AUDIT-1: real-world fenced shape parses**

```ts
it('T-AUDIT-1: real Gemini-2.5-Flash fenced output parses (audit-derived)', () => {
  // Verbatim sample from data/eval/r9-5a-audit/run-1 (groupId 958751334,
  // triggerHead "我喜欢你"). Captured 2026-05-05 with R9_PLANNER_AUDIT_RAW=1.
  const raw = '\`\`\`json\n{\n  "mode": "reply",\n  "length_budget": "short",\n'
            + '  "required_fact_ids": [],\n  "forbidden_tokens": ["说啥", "你谁"],\n'
            + '  "tone_hint": "像一个被表白了有点不知所措的群友",\n'
            + '  "use_sticker_token": true\n}\n\`\`\`';
  const parsed = tolerantParseDirective(raw);
  expect(parsed).not.toBeNull();
  const d = validateDirective(parsed, makeValidateCtx({ stickerAllowed: true }));
  expect(d).not.toBeNull();
  expect(d!.mode).toBe('reply');
  expect(d!.lengthBudget).toBe('short');
  // toneHint > 24 chars → sliced (D-6) — NB: existing T8 covers the slice
  // mechanic; this fixture additionally asserts the audit-real shape end-to-end.
});
```

**T-AUDIT-2: timeout sentinel (Option β chosen) — `plan()` throws on stuck LLM**

```ts
it('T-AUDIT-2: timeout fires PlannerTimeoutError (audit-derived: Gemini p95=1321ms vs 1500ms cap)', async () => {
  const stub = makeClaudeStub('never');
  const planner = new ReplyPlanner(stub, createLogger('test'), { timeoutMs: 50 });
  const ctx = makeBaseCtx();
  await expect(planner.plan(ctx, new AbortController().signal))
    .rejects.toBeInstanceOf(PlannerTimeoutError);
});
```

(Architect: if Option α picked, swap to: assert returned tagged result
`{ok:false, reason:'timeout'}`.)

**T-AUDIT-3: parse-fail vs timeout distinction**

```ts
it('T-AUDIT-3: LLM returns garbage → parse-fail path (NOT timeout)', async () => {
  const stub = makeClaudeStub('resolve', 'this is not json at all');
  const planner = new ReplyPlanner(stub, createLogger('test'), { timeoutMs: 5000 });
  const ctx = makeBaseCtx();
  // Option β: returns null (backward-compatible parse-fail signal)
  const out = await planner.plan(ctx, new AbortController().signal);
  expect(out).toBeNull();
});
```

**Edge tests (mandatory per `feedback_edge_testing_soul`)**:

- E1: cap boundary — LLM resolves at exactly cap-1ms → parses (not timeout)
- E2: cap boundary — LLM resolves at exactly cap+1ms → timeout fires
- E3: external AbortController fires before timer → distinguishes
  external-abort from internal-timeout (per Option β: external should NOT
  throw `PlannerTimeoutError` — it's a different concern. If Architect
  picks β: the abort listener also wraps `PlannerTimeoutError`, but only
  when `localController.signal.aborted && !signal.aborted` — i.e. our timer
  fired first. If signal was aborted externally first, throw a generic
  Error.) Architect should pin which behavior is desired; the simpler path
  is to ALWAYS throw `PlannerTimeoutError` since fail-open is the same in
  both cases — but that loses the external-abort distinction. **DESIGN
  recommends: `PlannerTimeoutError` covers both paths**, since `chat.ts`
  doesn't currently differentiate external-abort either.

`tsc` clean and full vitest no-regressions are baseline acceptance (per PLAN
§7 PRIMARY).

## §2 Out-of-scope (re-locked from PLAN, plus team-lead lock-ins)

PLAN §2 OUT OF SCOPE all carry forward verbatim. Additionally, per
team-lead 2026-05-05 directive:

- **No parser/prompt changes**: the audit invalidates §5/§6 of the PLAN's
  fix-strategy menu (parser-side normalization + validator-side leniency +
  prompt-side prevention). All three fix-flavors are dead-on-arrival because
  no failure modes need fixing. We honor `feedback_check_output_origin_before_prescribing_fix`
  by NOT shipping defensive fixes for phantom issues.
- **No touching `feat/r9-5-tune` commit `73999cb`** — its fate is task #43,
  not this PR. Honors `feedback_dont_let_specs_revise_against_shipped_commits`.
- **No widening scope to compensate for blast-radius concerns** (see §4).

## §3 Acceptance gates (revised per team-lead 2026-05-05)

### PRIMARY (must pass)

- **Parse rate `llm-planner / (llm-planner + rule-fallback)` ≥ 95%** of
  R9-active rows. Measured on a fresh real-LLM run of
  `benchmark-original-781` slice on `feat/r9-5a-parser-harden` HEAD with
  `R9_REPLYER_LITE_ENABLED=1` + `CHAT_MODEL=gemini-2.5-flash` (no
  `R9_PLANNER_AUDIT_RAW`). Audit reality is 100%; 95% gives slack for
  Gemini latency drift (network, regional routing variance, future
  API-side regressions).
- **`rule-fallback` ≤ 5%** of R9-active rows.
- `tsc` clean (0 errors).
- New audit-derived tests pass (T-AUDIT-1, T-AUDIT-2, T-AUDIT-3 + E1/E2/E3).
- Full `vitest` no new regressions vs master `9e7428a`.

### NEW SIDE OBSERVATIONS (not blockers)

- **Timeout count** post-fix: now distinguishable via the new
  `fellBackReason='timeout'` stamp. Reviewer logs the count in the run
  artifact. Expectation: ≤5% of R9-active rows. If higher, surface as a
  follow-up — Gemini latency may have drifted or regional issue.
- `fact-needed-no-fact` count: REPORTED but NOT a blocker (PLAN §7 carry-over).
  Task #43 owns that metric.

### KNOWN-EXPECTED BEHAVIOR CHANGE (NOT a regression — see §4)

- `direct-at-silenced` cluster will likely revert from R9.4 re-baseline
  (42→11) closer to the pre-R9 baseline (42). Reviewer flags this in their
  report but does NOT block the PR. See §4 for the full rationale.

### NOT in this acceptance set

- No reply-text quality eval. R9.5a is still structural-only.
- No real-group canary. R9.6 owns that.

## §4 Expected behavior shift (KNOWN, not regression)

Per team-lead 2026-05-05 explicit standing decision: this section is in
DESIGN as a known-expected signal, NOT a problem to fix.

**Why R9.4 re-baseline numbers will move**:

The R9.4 re-baseline (`docs/eval/r9-4-rebaseline-2026-05-05.md`) showed:

| Metric                          | Pre-R9 baseline | R9.4 (with timeout bug) | Why R9.4 looked good |
|---------------------------------|-----------------|--------------------------|----------------------|
| `direct-at-silenced`            | 42              | **11**                   | rule-fallback path   |
| `direct-at-silenced-by-abuse`   | 22              | **0**                    | rule-fallback path   |
| `direct-at-silenced-by-guard`   | 15              | **8**                    | rule-fallback path   |

**Causal mechanism the audit reveals**:

1. R9.4 had `R9_PLANNER_TIMEOUT_MS = 800ms` → 99% of R9-active rows hit
   timeout → `chat.ts:3232-3242` substitutes `buildFallbackDirective`
   (rule-based).
2. `buildFallbackDirective` for the engagement-mode='skip' + has-direct-trigger
   case maps to `mode='ack' + lengthBudget='tiny'` (per `reply-planner.ts:362-371`).
3. Some direct-at-silenced cases probably also hit the
   `engagementMode='skip' && !hasDirectTrigger` arm → `mode='silent'`.
4. The Replyer composing under `mode='silent'` directive emits no reply →
   silenced → metric counts as "compliant" instead of "direct-at-silenced".
5. Net effect: rule-fallback's silent-emission was suppressing the
   direct-at-silenced cluster, making R9.4 look like a -73% improvement.

**What R9.5a will do**:

Lifting parse rate from 0.9% to ~100% means LLM Planner's output (which the
audit shows is ALWAYS `mode='reply'` for direct-trigger samples in this
slice) flows to the Replyer for ~95% of R9-active rows. The Replyer then
composes a real reply for those rows → direct-at-silenced clusters revert
to roughly the pre-R9 levels.

**This is the intended R9 behavior**: R9 was designed to give the LLM
Planner the directive layer, not to silently suppress direct triggers via
rule-based fast-path. The R9.4 numbers were measuring "when timeout always
fires, rule-fallback's silent-emission is good at suppressing direct hits"
— which is a property of `buildFallbackDirective`, not of R9 working as
designed.

**What task #43 will determine** (post-R9.5a + re-benchmark):

| Outcome | Decision input for task #43 |
|---------|------------------------------|
| `direct-at-silenced` reverts to ~42 (pre-R9) AND `fact-needed-no-fact` ≤ 17 | R9 LLM Planner is doing nothing useful → consider sunsetting |
| `direct-at-silenced` stays low AND `fact-needed-no-fact` stays 17-21 | R9 working as designed via LLM Planner → proceed to R9.5/R9.6 |
| Both regress | R9 net loss → consider sunsetting |

**R9.5a does NOT widen scope to address this** (per team-lead lock-in). The
blast radius is observation input for #43, not in-scope work for this PR.

## §5 Audit log fate — KEEP, commit it

Per team-lead 2026-05-05 directive: the audit findings file
`data/eval/r9-5a-audit/audit-findings.md` stays in the repo and is part
of this PR. Rationale:

- Future spelunkers reading the timeout-bump commit will need to know WHY
  it changed from 800 → 1500. The findings file is the audit ground truth.
- It's documentation, not code — does not affect runtime, no security
  surface, no test churn.
- Reviewer can use it to verify the timeout-bump rationale during APPROVED
  gate.

The raw audit run artifacts (`data/eval/r9-5a-audit/run-1/replay-output.jsonl`,
`runner.log`) are NOT committed (large, binary-ish, easy to regenerate).
`.gitignore` may need a `data/eval/r9-5a-audit/run-*/` entry — Architect
checks; if `data/eval/replay/` is already gitignored similarly, mirror.

## §6 Verbatim diff plan (for Architect → Developer handoff)

### File 1: `src/modules/reply-planner.ts`

```diff
@@ Constants @@
-export const R9_PLANNER_TIMEOUT_MS = 800;
+export const R9_PLANNER_TIMEOUT_MS = 1500;

@@ NEW (export) — Option β (recommended). If Architect picks Option α,
   skip this and use tagged-result pattern instead. @@
+
+/** Sentinel thrown by the inner Planner timer arm. The wire site at
+ * chat.ts:3220-3225 catches and stamps fellBackReason='timeout'. Per
+ * R9.5a DESIGN §1.2 (audit found timeout was mis-attributed as 'parse'). */
+export class PlannerTimeoutError extends Error {
+  constructor() {
+    super('reply-planner timeout');
+    this.name = 'PlannerTimeoutError';
+  }
+}

@@ plan() — abortPromise rejector swap @@
-    const abortPromise = new Promise<never>((_resolve, reject) => {
-      localController.signal.addEventListener(
-        'abort',
-        () => reject(new Error('reply-planner timeout/abort')),
-        { once: true },
-      );
-    });
+    const abortPromise = new Promise<never>((_resolve, reject) => {
+      localController.signal.addEventListener(
+        'abort',
+        () => reject(new PlannerTimeoutError()),
+        { once: true },
+      );
+    });

@@ plan() — catch handler distinguish + rethrow @@
-    } catch (err) {
-      this.logger.debug(
-        { err: String(err), durationMs: this.now() - start, groupId: ctx.groupId },
-        'reply-planner LLM call failed (fail-open)',
-      );
-      return null;
-    } finally {
+    } catch (err) {
+      if (err instanceof PlannerTimeoutError) {
+        this.logger.debug(
+          { durationMs: this.now() - start, groupId: ctx.groupId },
+          'reply-planner timeout (fail-open)',
+        );
+        throw err; // bubble to chat.ts wire-site for fellBackReason='timeout'
+      }
+      this.logger.debug(
+        { err: String(err), durationMs: this.now() - start, groupId: ctx.groupId },
+        'reply-planner LLM call failed (fail-open)',
+      );
+      return null;
+    } finally {
```

NO other changes to reply-planner.ts. The audit hook from Designer's audit
run is NOT in the file at this point (already reverted).

### File 2: `src/modules/chat.ts`

Add import at the top of the existing planner-import group (line 82-86):

```diff
@@ imports @@
   R9_PLANNER_TIMEOUT_MS,
+  PlannerTimeoutError,
```

Update the wire-site catch at line 3220-3225:

```diff
@@ around 3217-3225 @@
       try {
         planned = await this.replyPlanner!.plan(plannerCtx, controller.signal);
-      } catch (err) {
-        this.logger.debug({ err: String(err), groupId }, 'r9 planner threw — fallback');
-        fellBackReason = 'timeout';
-      } finally {
+      } catch (err) {
+        if (err instanceof PlannerTimeoutError) {
+          fellBackReason = 'timeout';
+        } else {
+          this.logger.debug({ err: String(err), groupId }, 'r9 planner threw — fallback');
+          fellBackReason = 'timeout'; // unknown error — still fail-open as timeout
+        }
+      } finally {
```

(The `else` branch stamping `'timeout'` for unknown errors preserves
backward compatibility — that path was already stamping `'timeout'` for any
throw. Only `PlannerTimeoutError` is the typed-known case; everything else
keeps its current label.)

### File 3: `test/modules/reply-planner.test.ts`

Add `PlannerTimeoutError` to the imports at line 2-15:

```diff
@@ test imports @@
   tolerantParseDirective,
+  PlannerTimeoutError,
```

Append three new tests (T-AUDIT-1/2/3) in a new
`describe('reply-planner — R9.5a timeout fix + real-Gemini fixture')` block
at the end of the file. Verbatim source in §1.4 above.

Append edge tests E1/E2/E3 in the same describe block.

### File 4: `data/eval/r9-5a-audit/audit-findings.md` (NEW)

Already created on this branch. Architect verifies it's in the worktree.

### File 5 (conditional): `.gitignore`

Architect checks: if `data/eval/replay/run-*/` or similar is already
gitignored (or `data/eval/replay/` wholesale), add a mirror entry for
`data/eval/r9-5a-audit/run-*/` so the run artifacts don't get committed.
If `.gitignore` is more aggressive (e.g. `data/eval/*/run-*/`), no edit
needed.

## §7 Lock-comment update

Per PLAN §6: the existing lock comment at `reply-planner.ts:460`
("LOCKED per DESIGN §3.2") refers to the prompt block. R9.5a does NOT
modify the prompt, so that comment stays. NO update needed there.

A NEW lock comment IS warranted for `R9_PLANNER_TIMEOUT_MS`:

```ts
// LOCKED per R9.5a-DESIGN §1.1 — bumped 800ms → 1500ms after audit
// (data/eval/r9-5a-audit/audit-findings.md) showed Gemini Flash p95=1321ms,
// max=1472ms. 800ms cap was timeout-not-parse cause of 99% rule-fallback.
export const R9_PLANNER_TIMEOUT_MS = 1500;
```

Architect chooses whether to land this comment as part of the diff or hold
to a single-line const change — Designer leans toward keeping the comment
because the next person hitting this constant should not have to re-discover
the audit.

## §8 Standing rules (HARD — embedded for downstream)

Quoted verbatim from team-lead R9.5a Designer briefing because pipeline
agents do not see memory directly:

- ASCII single quotes only — NO smart quotes.
- No emojis. No Co-Authored-By. No `.claude/` paths in commits.
- Edge tests mandatory (E1, E2, E3 in §1.4).
- Conventional commits — recommended `fix(reply-planner):` or
  `fix(r9): correct planner timeout 800ms→1500ms (audit-grounded)`.
- Helpers normalize input internally — N/A for this PR (no new helpers).
- Validator at every boundary — N/A for this PR (validator is unchanged).
- Bot is groupmate not assistant — N/A for this PR (no prompt change).
- Metadata on result, no side-channel maps — Option β (typed exception)
  honors this; Option α (tagged result) also honors it.
- HTML/LLM selectors against real-site snapshot, not synthetic — T-AUDIT-1
  fixture is a verbatim audit-captured raw text, not synthetic.

## §9 Iteration Contract

- **Designer DELIVERABLE (this DESIGN.md)** — DONE on save.
- **Architect expected output** (`docs/specs/r9-5a-parser-DEV-READY.md`):
  - Pick Option α or β for the fellBackReason distinguisher (§1.2).
  - Pick whether to land the lock comment from §7.
  - Verbatim diff plan against `feat/r9-5a-parser-harden` HEAD applying
    §6 sketches.
  - Confirm `.gitignore` state for `data/eval/r9-5a-audit/run-*/`.
- **Developer expected output**:
  - Apply diff. `tsc` + `vitest`. Conventional commit. Push to
    `origin/feat/r9-5a-parser-harden`.
- **Reviewer expected output**:
  - Run real-LLM benchmark on 781-row slice; verify parse rate ≥95%,
    rule-fallback ≤5%.
  - Log timeout count and `fact-needed-no-fact` as side observations.
  - Run full `vitest` for no-regression.
  - Save review to `.claude/code-reviews.md`.
  - APPROVED or change-request loop.

Per `feedback_iteration_contract_needs_explicit_ack`: each phase MUST send
`SendMessage team-lead` with explicit ack of its output.

## §10 Open questions for Architect

1. Option α (tagged result) vs Option β (typed exception) for the
   fellBackReason distinguisher? Designer recommends β (smaller, contract-
   preserving). Architect picks.
2. Land the lock comment from §7 (recommended) or single-line const swap?
3. `.gitignore` mirror entry for `data/eval/r9-5a-audit/run-*/` — verify
   not already covered by an upstream rule.

No other open questions. The audit pinned the root cause; the fix is mechanical.
