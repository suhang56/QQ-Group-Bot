# R9.5a Planner Audit Findings — 2026-05-05

> Worktree: `.claude/worktrees/r9-5a-parser/` on `feat/r9-5a-parser-harden`
> Method: Option α (env-gated `R9_PLANNER_AUDIT_RAW=1` debug log in
> `reply-planner.ts` ~654, logs full raw text on every parse attempt; capped 4096 chars).
> One temporary calibration change for the audit run only:
> `R9_PLANNER_TIMEOUT_MS = process.env['R9_PLANNER_AUDIT_RAW'] === '1' ? 15000 : 800`
> (reverted before DESIGN — see §6 Audit-instrumentation fate).

## §1 Run config

- Model: gemini-2.5-flash via real LLM (not stub)
- Slice: `benchmark-original-781` (R9-active rows produced ~14% of total)
- Cost: < $0.50 cap, run ended on cost cap before full 781 finished
- R9 flag: `R9_REPLYER_LITE_ENABLED=1` + `CHAT_MODEL=gemini-2.5-flash`
- Output: `data/eval/r9-5a-audit/run-1/`
- **R9-active samples captured with raw text: 112** (sufficient for §2 tally)

## §2 Headline finding — root cause is timeout, not parser/prompt

| Metric | Value |
|---|---|
| Audit samples (R9-active rows where Planner LLM call returned) | **112** |
| `parseOk=true` (extractJson + JSON.parse succeed)              | **112 (100%)** |
| `parseOk=false`                                                | **0 (0%)**     |
| Validator-axis rejections (mode missing, fact-id non-string, …) | **0**         |
| Distinct shape modes observed                                  | **1** (`fence-json`) |

**100% of R9-active rows that received a Gemini Flash response parsed cleanly
through the existing `tolerantParseDirective` and `validateDirective`.**

The "0.9% parse rate" reported in `docs/eval/r9-4-rebaseline-2026-05-05.md` is
**not a parser failure**. It is **mis-attributed timeout**: the 800ms hard cap in
`R9_PLANNER_TIMEOUT_MS` aborts the LLM call before Gemini Flash responds in
~99% of cases, the catch in `reply-planner.ts:643-651` returns `null`, and the
caller in `chat.ts:3241` stamps `fellBackReason='parse'` because
`planned===null` (the only signal it has, since `'timeout'` is only stamped on
the OUTER `replyPlanner.plan()` throw, which the inner catch swallows).

## §3 Latency distribution (Gemini 2.5 Flash, R9-active rows, 15s timeout)

| Quantile | Latency (ms) |
|---|---|
| min  |  753 |
| p50  | 1065 |
| p75  | 1168 |
| p90  | 1256 |
| p95  | 1321 |
| p99  | 1395 |
| max  | 1472 |

| Bucket | Count / 112 |
|---|---|
| < 500ms  |   0 |
| < 800ms  |   1 (**0.89% — matches re-baseline 0.9% parse rate exactly**) |
| < 1000ms |  37 |
| < 1500ms | 112 (100%) |
| < 2000ms | 112 (100%) |

**The 800ms hard cap excludes ~99% of legitimate Gemini Flash responses.**
A cap of 1500ms (current p95+ headroom) would admit 100% of observed responses;
1300ms would admit ≥95%; 1200ms would admit ~90%.

## §4 Shape distribution (`raw` field, leading-prefix classification)

| Shape | Count / 112 |
|---|---|
| `fence-json` (```` ```json\n{...}\n``` ````) | **112 (100%)** |
| `fence-bare` (```` ```\n{...}\n``` ````)     |   0 |
| `bare-json` (`{...}`)                        |   0 |
| `bare-array` (`[...]`)                       |   0 |
| `other`                                      |   0 |

**Note**: the existing prompt at `reply-planner.ts:483` says
`只输出 JSON，不要任何解释、前缀、markdown fence。` — Gemini ignores
"no markdown fence". This isn't a problem because `extractJson`
(`src/utils/json-extract.ts:11`) already unwraps fences correctly. So this is
shape-tolerated, not shape-fixed.

## §5 Inner-JSON structural sample (n=112)

| Field | Coverage | Notes |
|---|---|---|
| `mode`              | 112/112 (100%) | all `'reply'` (slice is direct-heavy) |
| `length_budget`     | 112/112 (100%) | `tiny`: 26, `short`: 73, `normal`: 13 |
| `required_fact_ids` | 112/112 (100%) | all empty `[]` (slice is fact-light) |
| `forbidden_tokens`  | 112/112 (100%) | well-formed string arrays |
| `tone_hint`         | 112/112 (100%) | Chinese sentence fragments, < 24 chars OK |
| `use_sticker_token` | 112/112 (100%) | `true`: 71, `false`: 41, `null`: 0 |

All inner JSON is canonical snake_case (matches prompt schema); no
camelCase, no Chinese punctuation in JSON structure, no unquoted keys, no
single-quoted strings, no trailing comments, no prose-inside-JSON. Gemini
2.5 Flash on this prompt is **highly compliant**.

`tone_hint` examples (8 sampled):

```
困惑、疑问，寻求澄清
像一个热心的群友一样，但因为不确定要说什么，可能会用表情包。
闲聊，随意，有点困惑
像一个感到莫名其妙的群友
像一个群友一样，对别人的直接呼唤做出回应，语气略带疑惑。
随意，带点疑问和反问的语气
像一个被表白了有点不知所構
像一个困惑的群友，询问对方在说什么。
```

One sample exceeds 24 chars; `validateDirective` D-6 truncates to 24 — that
edge already has a unit test (T8).

## §6 Failure-mode table (per PLAN §3 deliverable shape)

| Mode # | Pattern (raw snippet)                                    | Frequency | Proposed fix         | Test fixture |
|--------|----------------------------------------------------------|-----------|----------------------|--------------|
| 1      | Timeout — no raw captured (LLM aborted at 800ms cap)     | ~99% prod | **infra (timeout calibration)** | reply-planner.test.ts: latency budget guard |
| 2      | Fence-wrapped clean JSON (```` ```json\n{...}\n``` ````) | 112/112   | **already tolerated** | T9d existing |
| 3      | (none)                                                   | 0         | n/a                  | n/a          |

The Planner-locked "5 expected failure modes" hunch in `r9-5a-parser-PLAN.md`
§4 (markdown fence, prose preamble, snake/camel mismatch, Chinese punct,
unquoted keys, trailing comments, null values, empty object) — **none of
these occur** in real Gemini Flash output for this prompt. All hunches are
falsified by the audit.

## §7 Audit-instrumentation fate

The two-line audit hook in `reply-planner.ts:655-674` was a temporary
debug-flag (Option α). Architect/Developer should **strip it from the final
PR** — recommendation per PLAN §10 — because:

1. The audit yielded a definitive answer (parser is fine).
2. Production has no need for it; would clutter logs at info level.
3. If future re-audit is needed, it's a 5-line re-add.

The temporary `R9_PLANNER_TIMEOUT_MS` env-conditional was reverted before
this audit-findings.md was finalized. **Source state at audit-findings save
time matches base `9e7428a` plus zero changes.**

## §8 Scope implication for R9.5a

The PLAN scope was "lift parse rate ≥80% via parser/prompt hardening". The
audit shows parse rate is ALREADY 100% on responses received — the actual
defect is **timeout calibration + fellBackReason mis-attribution**.

This is a **scope shift** that R9.5a Designer must surface to team-lead BEFORE
writing DESIGN.md, per PLAN §3.2 ("If audit shows surprises that require
scope expansion, SendMessage team-lead BEFORE writing DESIGN — don't silently
expand scope.")

Recommendation: re-scope R9.5a to one of three shapes (team-lead picks):

- **(A) Timeout-only**: bump `R9_PLANNER_TIMEOUT_MS` 800 → 1500 (covers
  100% of observed Gemini Flash responses; keeps total Planner overhead well
  under R9 latency budget per re-baseline). Add `'timeout'` distinguisher in
  `chat.ts:3241` so `fellBackReason` correctly reports timeout vs parse vs
  validate (downstream eval clarity). Tiny diff (~5 lines), high ROI.

- **(B) Timeout + observability**: (A) PLUS expose timeout count in summary
  (so reviewer can verify post-fix that timeouts are <5%). Adds ~30 lines.

- **(C) Full PLAN scope**: ignore audit, ship parser hardening anyway as
  defensive depth-of-prevention even though no observed failure mode warrants
  it. **Not recommended** — violates `feedback_check_output_origin_before_prescribing_fix`
  ("修 bot 行为前确认 codepath") — we'd be fixing a phantom problem.

The Designer's recommendation is **(A)**: smallest blast radius, highest signal,
maps 1:1 to the audit-derived root cause. Acceptance gate from PLAN §7 still
applies: **parse rate ≥80% of R9-active rows** is the metric; under (A)
post-fix run should see ≥95%.
