# R9.5a — Planner parser/prompt hardening for Gemini Flash — PLAN

> Phase: R9.5a (precedes R9.5) / Planner / 2026-05-05
> Worktree: `.claude/worktrees/r9-5a-parser/` on `feat/r9-5a-parser-harden`
> Branch base: master `9e7428a` (post-PR #179 harness fix merged)
> Author: r9.5a-planner. Project plan: `~/.claude/plans/curried-wondering-rocket.md` lines 175-181.
>
> Scope: targeted, narrow. Lift `tolerantParseDirective` parse rate on
> Gemini-2.5-Flash output from `0.9%` (1/112 R9-active rows in the
> 2026-05-05 re-baseline) to `>=80%`. NO reply behavior change, NO retrieval
> change, NO R9.5 prompt addition or factsByIdMap hydration (those return
> in task #43 R9.5 fate decision).

## §0 Project context (where R9.5a sits in the R9 split)

R9.5a is a NEW phase inserted **before** R9.5. Per `~/.claude/plans/curried-wondering-rocket.md`
lines 175-181 the original R9 split was R9.1..R9.6 with R9.5 = "tune iteration".
The fixed-harness re-baseline (`docs/eval/r9-4-rebaseline-2026-05-05.md`)
showed the LLM Planner is wired correctly but its output never reaches the
Replyer because the parser rejects ~99% of Gemini Flash outputs. R9.5
(prompt addition + factsByIdMap hydration, branch `feat/r9-5-tune` commit
`73999cb`) is HELD because both of its mechanisms only fire on parse-success
rows, so its measured effect is currently ceilinged by the parse rate.

| Phase  | Scope                                                                  | Status                  |
|--------|------------------------------------------------------------------------|-------------------------|
| R9.4   | Real-LLM benchmark on `benchmark-original-781`                         | Re-baselined 2026-05-05 |
| R9.5a  | **Planner parser + prompt hardening (THIS PR)** lift parse to >=80%    | This PLAN               |
| R9.5   | Prompt addition + factsByIdMap hydration                               | HELD (commit `73999cb`) |
| R9.6   | Real-group canary                                                      | BLOCKED on R9.5a        |

## §1 Problem statement

Re-baseline tally on master `9e7428a` over 781 rows
(`data/eval/replay/r9-4-rebaseline-r9-on/replay-output.jsonl`):

| Source                            | Count | % of total | % of R9-active |
|-----------------------------------|-------|------------|----------------|
| `llm-planner` (clean parse)       |     1 |    0.13%   |     0.89%      |
| `rule-fallback`                   |   111 |   14.21%   |    99.11%      |
| (null) — R9 gate skipped path     |   669 |   85.66%   |       —        |
| Total R9-active (planner ran)     |   112 |   14.34%   |   100.00%      |

Of the 112 rows where R9 fires the Planner LLM, only **1** parses cleanly.
The remaining 111 fall through `tolerantParseDirective` → `null` → caller
substitutes a rule-based Directive (`reply-planner.ts:654-660` returns null,
`chat.ts:3227-3242` builds `buildFallbackDirective`, sets `plannerSource =
'rule-fallback'`, and stamps `fellBackReason = 'parse'` since `planned ===
null`). The wire is correct; the **parser-vs-prompt contract** with Gemini
2.5-Flash is the failure axis.

This means the R9 win delivered to date (direct-at-silenced 42 -> 11) comes
from rule-fallback Directives, NOT from the LLM Planner. The intended R9
value (Planner emits structured directive; Replyer composes under
constraint) is effectively undelivered until parse rate is fixed.

## §2 Scope

### PRIMARY (in scope)

1. **Audit step (prereq)** — capture 50-100 raw planner LLM outputs from a
   fresh real-LLM run with the same `benchmark-original-781` slice, by
   instrumenting either the planner or the replay-output row to surface raw
   text. The current `replay-output.jsonl` does NOT carry raw planner text
   (verified — fields end at `errorMessage,durationMs,llm*Tokens,llmCostUsd`).
   The audit is the input to the targeted parser fixes; without it we'd be
   guessing failure modes. See §3 for the audit method options.

2. **Targeted `tolerantParseDirective` fix** — add narrow normalization passes
   that handle each documented failure mode from §4. NOT a wildcard
   "infinite tolerance" rewrite. Each new normalization step has a fixture
   test built from a real audit-captured raw output. Any output mode the
   audit does NOT surface gets NO new code path. Deletions/refactors of
   existing parser logic are out of scope unless audit shows the existing
   step is provably wrong.

3. **Targeted `R9_PLANNER_SYSTEM_PROMPT` constraint additions** — for each
   recurring shape in the audit that can be prevented at source rather than
   tolerated at the parser, add an explicit single-bullet constraint to the
   prompt. NOT a full rewrite; insert minimal lines in the `约束:` block at
   `reply-planner.ts:482-488`. Prompt deltas are validated by a small mock
   test that the new prompt content is wired into the planner system message.

### OUT OF SCOPE (user-locked verbatim, 2026-05-05)

- ANY reply behavior change (Replyer composition, Directive consumption,
  prompt-block builder, length-budget enforcement, sticker policy). The
  Replyer must stay byte-identical for non-R9-active rows AND for R9-active
  rows with the same final `Directive` shape.
- ANY facts retrieval / `requiredFactIds` changes (no new retrieval
  paths, no `getFactsByIds`, no `factsByIdMap` hydration). R9.5 owns those.
- The R9.5 prompt addition from commit `73999cb`. R9.5a does not reuse it
  even if §4 audit overlaps with R9.5's prompt-addition scope.
- The R9.5 `factsByIdMap` hydration from commit `73999cb`.
- chat.ts edits beyond what is strictly required for the audit-logging
  hook in §3 (and that hook is dev-only / gated, not production-bound). If
  the chosen audit method (γ separate script) needs no `chat.ts` edit, the
  diff to `chat.ts` is zero.
- Composer changes (`chat-composer*`, `chat-prompt*`, persona prompt).
- DB schema / `chat_decision_events` columns. The `directive_json` column
  already exists for the parsed shape; no new column for raw text in prod.
- Replay-output JSONL schema additions visible in production. (Optionally
  the audit method may add a dev-only field; it must not be persisted in
  the shipped `replay-output.jsonl` schema. See §3.)

## §3 Audit prereq — capture 50-100 raw planner outputs

**Why audit, not just write fixes**: Reviewer's PR #179 LOW finding flagged
the parse-rate gap; re-baseline confirmed it. But neither identified WHICH
shape Gemini emits. Without the actual failure modes we'd add prophylactic
code paths that may not match prod behavior (per `feedback_check_output_origin_before_prescribing_fix`
and `feedback_audit_findings_can_underspecify_real_failure_mode`).

### Method options

**Option α — tolerantParseDirective debug-flag**
Add an env-gated branch inside `reply-planner.ts:654-660` (the existing
`parsed === null` debug-log path). Today it logs `raw.slice(0, 120)`. Under
`R9_PLANNER_AUDIT_RAW=1`, log the FULL raw text (still bounded — cap at
4096 chars to be safe) at `info` level with a structured tag like
`{ phase: 'r9-5a-audit', groupId, raw, sampleId? }`.

- Pros: minimal diff (~5 lines in reply-planner.ts only); no schema change;
  audit is reproducible by anyone setting the env var.
- Cons: needs a tag that ties log line back to the replay row. The Planner
  doesn't currently know `sampleId`. Either (a) add an optional
  `auditTag?: string` field to `PlannerContext` (only set in audit runs;
  defaults to undefined; harmless to validation), or (b) match log line to
  replay row by `groupId + ts`. (a) is cleaner; (b) is fragile.
- Output capture: a side-process tail of the planner log file into a JSONL
  audit file, OR re-run the small slice with stdout captured.

**Option β — already-captured raw text**
Read existing `replay-output.jsonl`. **Verified absent**: a sampled row
(line 1 of the re-baseline file) shows fields up to `llmCostUsd` and no
`directiveJson` / `plannerRaw` / `plannerError`. So β is dead. Recording
this here so the Architect doesn't re-investigate.

**Option γ — separate one-off audit script**
A standalone `scripts/eval/r9-5a-audit-raw-planner.ts` that:
  1. Loads `data/eval/benchmark-original-781.jsonl`.
  2. Runs the same RealClaudeClient + ReplyPlanner wiring as the replay
     runner, but ONLY for ~100 R9-active rows (filter to rows where
     `r9-active` predicate would fire — known via prior re-baseline tally
     of `plannerSource ∈ {rule-fallback, llm-planner}`).
  3. For each row, captures `{ sampleId, raw, parseOk, errorReason? }`
     into a fresh `data/eval/r9-5a-audit/audit-raw.jsonl`.
  4. Reuses production `tolerantParseDirective` so "parseOk" is honest.
- Pros: zero source-tree edit (script-only); fully reproducible; easy
  re-run after fix to confirm.
- Cons: ~100 lines of new script code; ~$0.02 in extra Gemini Flash spend
  for the 100-row run; the script must mirror replay-runner-core's wiring
  faithfully (drift risk).

### Recommendation

**Option α (debug-flag with `auditTag` PlannerContext field)** is the
recommended primary, with **Option γ as a fallback** if the Architect
finds α's log-tail capture too fragile under Windows shells. Reasoning:

- α has a tiny diff that lives in code review alongside the parser fix;
  reviewer can see audit instrumentation and the fix in the same PR.
- α can stay disabled by default (env-gated), so it ships safely.
- α reuses replay-runner-core; γ has to mirror it (drift).

Architect picks final method during DEV-READY. If α picked: `auditTag`
field is a `readonly auditTag?: string` on `PlannerContext` (optional,
only populated in audit-flagged runs; harmless validation no-op).

### Audit deliverable shape

A markdown table at `data/eval/r9-5a-audit/audit-findings.md`:

| Mode # | Pattern (example raw snippet)         | Frequency | Proposed fix | Test fixture |
|--------|---------------------------------------|-----------|--------------|--------------|
| 1      | (audit-derived)                       | x/100     | parser/prompt| filename.ts  |
| 2      | (audit-derived)                       | y/100     | ...          | ...          |

Architect translates this into the verbatim diff plan; Developer ships
fixtures + parser deltas + prompt deltas matched 1:1 to mode rows.

## §4 Pre-audit hunch: top expected failure modes

Listed for triangulation only. The audit findings (§3) supersede this
list. The Developer/Architect MUST NOT pre-implement against this list
before audit data lands.

1. **Markdown fence wrapper** — Gemini emits ```json\n{...}\n``` even
   though prompt says "no markdown fence". Existing `extractJson` already
   handles fences (`json-extract.ts:11`), so this should NOT be the top
   mode. If audit shows it IS prevalent, the existing fence regex may
   fail on edge cases (fenced WITHOUT trailing newline; nested triple
   backticks inside `tone_hint` string; language tag variations like
   `JSON`/`Json`/no-tag).

2. **Prose preamble / trailing prose** — `这是一个回复计划：{...}` or
   `{...}\n以上是计划` wrapping the JSON. `extractJson` walks for `{`
   so the preamble is stripped, BUT trailing prose AFTER the closing
   `}` is also stripped already (the bracket-counter ends at `depth ===
   0`). So this should also not be the top mode unless prose appears
   INSIDE the JSON (e.g. as a comment-style line `// 备注` between
   fields, which is invalid JSON and would fail the `JSON.parse`).

3. **Snake_case vs camelCase field names** — `validateDirective` ALREADY
   accepts both (`reply-planner.ts:241,251,265,282,292`). So if Gemini
   emits all-snake_case, validator handles it. BUT if `extractJson`
   succeeds and `validateDirective` returns null because `mode` is
   missing or unrecognized, `tolerantParseDirective` → `chat.ts:3227`
   path: `validated === null` → `plannerSource = 'rule-fallback'` with
   `fellBackReason = 'validate'`. Important: if §3 audit shows many
   rows reach this branch (parse OK, validate fails), the fix lives
   in `validateDirective` not in the parser.

4. **Chinese punctuation in JSON** — Gemini using `，` (full-width
   comma) or `：` (full-width colon) inside the JSON structure (NOT
   inside string values; in string values that is fine). Standard
   `JSON.parse` rejects this. A targeted normalize pass in
   `tolerantParseDirective` could replace structural full-width
   punct only OUTSIDE strings — non-trivial; needs the bracket-walker
   from `extractJson` to be string-aware. If audit shows this mode,
   simpler fix: add a prompt-side bullet: `- JSON 结构使用半角符号
   {} [] : , "`.

5. **Unquoted keys / single-quoted strings** — `{mode: 'reply', ...}`.
   Fixed by a normalize pass: detect `{<unquoted_word>:` and quote it,
   detect `'...'` strings and switch to `"..."`. RISKY if string values
   contain literal apostrophes. Likely too noisy to fix at parser; the
   prompt fix (`使用双引号`) is cheaper and safer.

6. **Trailing comments** — `"mode": "reply" // 用户问问题`. Already-existing
   `JSON.parse` rejects this. A targeted `//.*$` strip MUST be
   string-aware (`"http://..."` would be wrongly mangled). Likely
   prompt-fix candidate, not parser-fix.

7. **`null` values where validator expects something else** — e.g.
   `"required_fact_ids": null` instead of `[]`. `validateDirective`
   defaults to `[]` already (only sets the array if `Array.isArray`).
   Should NOT cause failure; included for completeness.

8. **Empty object `{}` or `null` literal** — model returns `{}` or
   `null`. `validateDirective` will return null because `mode` is
   missing. Fallback to rule. This is a `fellBackReason = 'validate'`
   case. Possibly fixable by prompt: explicitly require `mode` field.

The audit will collapse the actually-occurring subset of these into a
small list (probably 3-5 modes carry 90% of the failures). The fix
strategy in §5 / §6 keys off the audit table, not this hunch list.

## §5 Parser fix strategy (binds 1:1 to §3 audit findings)

For each audit-found mode, ONE of three fixes applies, picked by the
Architect from the Developer-implementable menu:

- **Parser-side normalization** — added in `tolerantParseDirective`
  BEFORE the existing strict + loose attempts. Each pass is pure,
  string-in/string-out, and idempotent. Order: most-specific first
  (e.g. fence-strip BEFORE bracket-walk; punct-normalize AFTER fence-
  strip). Each pass has its own targeted unit test against an
  audit-captured raw fixture.

- **Validator-side leniency** — added in `validateDirective` when the
  audit shows parse is fine but validation rejects. Each addition is
  a SINGLE field-level relaxation with cross-field invariants
  preserved (D-1, D-3, D-5, D-15 stay enforced). New tests cover the
  new acceptance shape AND verify the existing invariants still fire.

- **Prompt-side prevention** — single-bullet addition to the
  `约束:` block. Each new bullet has a small mock test asserting the
  bullet is present in the system prompt string (regression guard).

**Locked acceptance criterion for parser fixes**: every new code path
in `tolerantParseDirective` has at least ONE test fixture sourced from
real audit raw text. NO new code path may be added on the strength of
§4 hunch alone. (Per `feedback_html_scraper_fixtures` and
`feedback_check_output_origin_before_prescribing_fix`.)

**Helpers normalize input internally** (per `feedback_normalize_inside_helper`):
all new normalize passes live INSIDE `tolerantParseDirective` —
callers pass the same raw string they always have.

**Validator at every boundary** (per `feedback_validator_at_every_boundary`):
parser returning a parsed-but-not-yet-validated object is unchanged;
`validateDirective` continues to be the final boundary at
`chat.ts:3227`. Audit-driven validator changes go through it; no new
side-channel acceptance path.

## §6 Prompt fix strategy

Insert minimal bullets into `R9_PLANNER_SYSTEM_PROMPT` `约束:` block at
`reply-planner.ts:482-488`. Locked rules:

- Each new bullet maps to ONE audit-found failure mode.
- Each new bullet is in Chinese (matches existing prompt language).
- ASCII single quotes only in source (per standing rules).
- The TOTAL prompt addition for R9.5a is bounded at ≤8 new bullets and
  ≤500 chars; if §3 audit suggests more, escalate to team-lead with
  scope-creep flag rather than absorbing.
- The DESIGN §3.2 lock comment in `reply-planner.ts:460` ("LOCKED per
  DESIGN §3.2") MUST be updated by Architect to point to a new
  R9.5a-DESIGN-NOTE section that records WHY the prompt is being
  unlocked under R9.5a. (Honoring `feedback_dont_let_specs_revise_against_shipped_commits`
  — the prompt was locked by R9.1; R9.5a is a deliberate revision, not
  drift.)

R9.5's commit `73999cb` prompt addition is **explicitly NOT carried in**.
That addition relates to `requiredFactIds` semantics (a behavior axis);
R9.5a is shape-only. If audit shows overlap, escalate; do not silently
absorb.

## §7 Acceptance gates

### PRIMARY (must pass)

- **Parse rate ≥80% of R9-active rows**. R9-active = rows with
  `plannerSource ∈ {llm-planner, rule-fallback}` AND `fellBackReason ∈
  {parse, validate, null}` (i.e. excludes timeout/abort which are
  non-parser failures). Measured on a fresh real-LLM run of
  `benchmark-original-781` slice on `feat/r9-5a-parser-harden` HEAD
  with `R9_REPLYER_LITE_ENABLED=1` + `CHAT_MODEL=gemini-2.5-flash`.
- `rule-fallback` count ≤10% of R9-active rows. (i.e. ≥90% reach
  `llm-planner` cleanly. The 80% gate above gives a 10pp cushion for
  intermittent timeouts / transient validate failures that aren't
  parser-axis bugs; the 90% target is internal stretch.)
- `tsc` clean (0 errors).
- New audit-derived parser/validator tests pass.
- Full `vitest` no new regressions vs master `9e7428a`.

### SIDE OBSERVATIONS (NOT blockers)

- `fact-needed-no-fact` count post-fix is REPORTED but does NOT block.
  R9.5 (next phase) owns that metric. Reviewer logs the count for the
  task #43 fate decision input.
- `direct-at-silenced` cluster wins should hold (was 42 -> 11 on the
  May 5 re-baseline). If parser hardening accidentally REGRESSES this
  cluster (e.g. by lifting parse rate enough that LLM Planner's
  `mode='reply'` now overrides rule-fallback's `mode='silent'` on
  adversarial-direct rows), Reviewer flags but does NOT block the PR
  — that's a Replyer-behavior signal that belongs to R9.5/R9.6.

### NOT in this acceptance set

- No reply-text quality eval. R9.5a is structural.
- No real-group canary. R9.6 owns that.

## §8 R9.5 fate gate (post-R9.5a, owned by task #43)

After R9.5a ships and re-benchmark lands, task #43 evaluates:

- **If `fact-needed-no-fact` (currently 21 vs pre-R9 baseline 17, +4)**
  on the post-R9.5a run still has gap ≥3:
  → REVIVE R9.5 commit `73999cb` (prompt addition + factsByIdMap
  hydration). Rebase onto post-R9.5a master. Run full R9.5 5-agent
  pipeline with the post-R9.5a baseline as the comparison ground.

- **If gap collapses to 0-2 on post-R9.5a run**:
  → KILL R9.5 prompt addition. Salvage ONLY the `factsByIdMap`
  hydration from `73999cb` as a standalone small infra-prep PR
  (Architect §1A R9.3 follow-up ticket per re-baseline doc §R9.5
  fate decision recommendation). Hydration is "always-useful" infra
  per the re-baseline doc §54-56.

- **If gap collapses but a NEW R9.5a-introduced regression appears
  on a different metric** (e.g. `direct-at-silenced` reverts):
  → that's a Replyer behavior bug surfaced by lifting parse rate.
  Spin a dedicated R9.5b (Replyer-side) phase; do NOT bundle into
  task #43 R9.5 fate.

Task #43 is a separate 5-agent dispatch and is NOT R9.5a's
responsibility to schedule.

## §9 Standing rules (HARD — embedded for downstream agents)

Quoted verbatim from team-lead briefing because pipeline agents do
not see memory directly (per `feedback_embed_standing_rules_in_agent_briefing`):

- ASCII single quotes only — NO smart quotes (per `feedback_no_smart_quotes`).
- No emojis. No Co-Authored-By. No `.claude/` paths in commits.
- Edge tests mandatory (per `feedback_edge_testing_soul`).
- Conventional commits (`feat:` / `fix:` / `refactor:` / `docs:` /
  `test:` / `chore:` / `feat(reply-planner):`).
- Helpers normalize input internally (per `feedback_normalize_inside_helper`).
- Validator at every boundary (per `feedback_validator_at_every_boundary`).
- Bot is groupmate not assistant (per `feedback_groupmate_not_assistant_lens`)
  — N/A for parser fix but applies if audit triggers prompt rewording.
- Metadata on result, no side-channel maps (per
  `feedback_metadata_on_result_not_side_channel`) — N/A for parser
  fix; applies if audit method α adds an `auditTag` field, must live
  on PlannerContext, not a Map keyed by groupId.
- HTML/LLM selectors against real-site snapshot, not synthetic (per
  `feedback_html_scraper_fixtures`) — applies to all audit-derived
  test fixtures.

## §10 Iteration Contract

Phase order: Planner (THIS) → Designer → Architect → Developer → Reviewer.

- **Planner DELIVERABLE (this PLAN.md)**:
  - §1 Problem statement — DONE
  - §2 Scope (PRIMARY 3 + OUT-OF-SCOPE 7 user-locked) — DONE
  - §3 Audit method options + recommendation — DONE
  - §4 Pre-audit hunch — DONE (advisory)
  - §5/§6 Fix strategy menu — DONE
  - §7 Acceptance — DONE
  - §8 R9.5 fate gate — DONE

- **Designer expected output** (`docs/specs/r9-5a-parser-DESIGN.md`):
  - Run the audit per §3 (α or γ); produce `data/eval/r9-5a-audit/audit-findings.md`.
  - For each audit mode, pick fix flavor (parser / validator / prompt).
  - Specify exact field/method shape for `auditTag` if α picked.
  - List test fixtures (filename + raw text source).

- **Architect expected output** (`docs/specs/r9-5a-parser-DEV-READY.md`):
  - Verbatim diff plan against `feat/r9-5a-parser-harden` HEAD.
  - File-by-file: `reply-planner.ts` (parser/prompt), test files,
    optional `scripts/eval/r9-5a-audit-raw-planner.ts` if γ picked.
  - DESIGN §3.2 lock-comment rewording.

- **Developer expected output**:
  - Implement diff. Run `tsc` + `vitest`. Conventional commit. Push to
    `origin/feat/r9-5a-parser-harden`.

- **Reviewer expected output**:
  - Run real-LLM benchmark on 781-row slice; verify parse rate ≥80%.
  - Run full `vitest` for no-regression.
  - Save review to `.claude/code-reviews.md`.
  - APPROVED or change-request loop.

Each phase MUST send `SendMessage team-lead` with explicit ack of
its output (per `feedback_iteration_contract_needs_explicit_ack`).
