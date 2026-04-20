# Feature: R6.3 — Offline Replay Runner

## Why

R6.1 produced weak-labeled benchmark. R6.2 hand-curated 493 gold rows (`gold-493.jsonl`) across all 10 category buckets. R6.3 is the **exam room**: run the current bot against every gold sample with a deterministic mock LLM, tag each outcome against gold, emit a frozen master baseline that all future branches (R4-lite, R5, Strategy A/B) diff against.

Plan reference: `curried-wondering-rocket.md` § "R6 — Offline Replay Harness + Gold Set". Prerequisite for R2a/R4-lite/R5 which all need distribution-grounded offline evaluation.

North-star lens: the score measures whether bot stays **groupmate** (silent/defer when it should) — not whether it produces text.

## Gold distribution (input facts, frozen)

- **goldAct**: silence 147 · chime_in 127 · relay 64 · object_react 51 · direct_chat 51 · meta_admin_status 30 · conflict_handle 13 · bot_status_query 9 · summarize 1
- **goldDecision**: reply 291 · silent 100 · defer 102
- **flags**: factNeeded 67 · allowBanter 181 · allowSticker 61
- **Weak-vs-gold agreement baseline**: 46.7% (230 / 493)

## Scope

1. `scripts/eval/summarize-gold.ts` — read-only sanity audit of gold + benchmark; stderr only; exit 0 always
2. `scripts/eval/replay-runner.ts` — join gold↔benchmark by sampleId, instantiate ChatModule with mock wiring, call `generateReply`, capture ChatResult, write `replay-output.jsonl` + `summary.json`
3. `scripts/eval/violation-tags.ts` — pure function `computeViolationTags(gold, replay) → string[]`; 10 frozen tags; no src/ imports
4. `scripts/eval/replay/` helpers — mock LLM (hash-stub), mock adapter, mock repos, fixture builder, argparse shims (split at Architect's discretion)
5. `src/test-mocks/` — reusable mock seams if ChatModule construction requires them
6. `test/eval/violation-tags.test.ts` — ≥1 positive + ≥1 negative unit test per tag (10 × 2 minimum)
7. `test/eval/replay-runner-mock.test.ts` — mock LLM determinism, zero-write-side-effect assertion, sampleId join, missing-benchmark-row → warn+skip
8. `test/eval/summarize-gold.test.ts` — smoke on 5-row synthetic fixture, exit 0
9. `docs/eval/replay-runner.md` — usage + output-field reference
10. `.gitignore` addition: `data/eval/replay/*`

## Out of scope (Reviewer rejects if Dev adds)

- Any edit to `src/modules/`, `src/ai/`, `src/storage/`, `src/adapter/`, `src/services/` beyond new test seams
- Prompt / persona / system-prompt edits
- Engagement-decision, threshold, fatigue, cooldown, or scoring-weight tuning
- Fact-retrieval / FTS / BM25 / embedding changes
- Any fix for violations found in the smoke run (they are DATA for future phases)
- `recorded` LLM mode (kept as `throw "not implemented"` stub)
- Post-merge 493-sample baseline commit (owner runs separately; output gitignored)
- Real Gemini/Claude calls during replay
- Dashboard or visualization (R6.4's job)

## Acceptance criteria

- [ ] `summarize-gold.ts --gold gold-493.jsonl --benchmark benchmark-weak-labeled.jsonl` prints full sanity report; exits 0
- [ ] `replay-runner.ts --llm-mode mock --limit 20` completes in < 60s; `replay-output.jsonl` has 20 rows with no null in `resultKind|reasonCode|utteranceAct|usedFactHint|matchedFactIds|violationTags`; `summary.json` has `silence_defer_compliance` in [0,1]
- [ ] `violation-tags.ts` exports `computeViolationTags` + `BANTER_PATTERNS`; zero `src/` imports; 10 tags frozen
- [ ] `test/eval/violation-tags.test.ts` ≥ 20 assertions (10 tags × positive + negative); `npm test` green
- [ ] `test/eval/replay-runner-mock.test.ts`: mock write-call count == 0; sampleId join works; missing-row skipped with warning
- [ ] `npx tsc --noEmit` zero new errors
- [ ] `data/eval/replay/` in `.gitignore`; no replay output committed
- [ ] Zero changes to `src/` runtime paths (Reviewer diffs `git diff --stat HEAD src/`)
- [ ] Primary metric computable: `silence_defer_compliance = |{gold∈{silent,defer} AND resultKind NOT reply}| / |{gold∈{silent,defer}}|` (denominator = 202)

## Edge cases to test

- Gold sampleId absent from benchmark → warn + skip; no crash; summary denominator excludes it
- Benchmark row with empty `triggerContext` → pass `[]` to `recentMessages`; runner does not crash
- Mock LLM returns empty string → downstream ChatModule guards fire; runner captures whatever ChatResult emerges (sentinel/fallback/silent); no special-casing
- `defer` result with `targetMsgId=''` → `target-mismatch` tag must NOT fire on empty string (requires non-null AND ≠ gold trigger id)
- `gold.factNeeded=true` + `gold.goldDecision='silent'` → `fact-needed-no-fact` evaluates and may fire; document as expected (tag is a lens, not a bug signal alone)
- `resultKind='sticker'` + `allowSticker=true` + `goldAct='object_react'` → `object-react-missed` must NOT fire (condition requires `resultKind='reply'`)
- `--limit 0` → both output files written as empty/zeroed; exit 0
- Malformed JSONL row (missing required field) → log warning + skip row; runner continues; does not crash
- CQ-heavy `rawContent` (image/voice CQ codes) → runner strips to text; mock LLM receives deterministic input; no JSON parse error
- `--limit 20` smoke mode on 493-row gold file → 20 rows processed deterministically; same seed → same output

## Open questions for Designer / Architect

1. **utteranceAct classifier**: does any `src/` classifier exist that can be called from scripts without a full ChatModule? If not, stub `'unknown'` for R6.3 with a `TODO(R6.4)` comment — Designer confirm stub is acceptable.
2. **Join key exact names**: gold has `sampleId`; benchmark field name needs confirmation (`id`? `sampleId`?). Designer doc to pin both sides.
3. **Mock DB seeding**: which rows does ChatModule read during `generateReply` (group config, affinity, lore, learned_facts)? Architect to enumerate and decide: (a) `:memory:` sqlite with fixture seed vs (b) stubbed repos returning canned data. Prefer (b) for determinism.
4. **Banter regex seed list**: Designer proposes 3–4 patterns for `BANTER_PATTERNS`; partial list acceptable for first cut — tag semantics frozen regardless.
5. **Per-sample timeout**: Architect to decide wall-clock limit per sample in mock mode. Recommended: 10s; log+skip on timeout without crashing runner.
6. **Violation tag exact string literals**: Designer to publish frozen tag-name list (10 tags) that both `violation-tags.ts` and tests import from a shared `const`.
