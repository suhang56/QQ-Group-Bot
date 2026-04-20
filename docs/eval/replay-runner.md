# R6.3 Replay Runner

Offline replay of the production bot's `ChatModule.generateReply` against the
hand-curated `gold-493.jsonl` set, with a deterministic mock LLM. Produces a
per-sample JSONL + an aggregate `summary.json` carrying headline
silence/defer compliance, violation tag counts and rates, and distributions.

Infrastructure only — zero `src/` edits. Smoke-run violations are DATA for
future phases, not bugs to fix here.

## CLI usage

```
cross-env NODE_OPTIONS=--experimental-sqlite \
  npx tsx scripts/eval/replay-runner.ts \
    --gold        data/eval/gold/gold-493.jsonl \
    --benchmark   data/eval/r6-1c/benchmark-weak-labeled.jsonl \
    --output-dir  data/eval/replay/smoke-baseline \
    --llm-mode    mock \
    --prod-db     <path-to-sqlite> \
    --bot-qq      <botQQ> \
    --group-id    <groupId-benchmark-was-sampled-from> \
    [--limit      <N>] \
    [--timeout-ms <ms>]
```

Exit codes:
- `0` — success
- `1` — invalid args / missing input file
- `2` — `--llm-mode=real|recorded` (not implemented) or zero rows processed
- `3` — output write error or zero-side-effect tripwire fired

`--prod-db` is **tmp-copied** under `<output-dir>/.tmp/` before any open; the
runner refuses to proceed if the resolved tmp path does not contain `.tmp` or
`synthetic`. Any incidental writes (`MoodTracker.flush` on destroy) land in
the tmp copy, not the source.

## Build synthetic fixture DB

The integration test + docs smoke use a 2-row synthetic sqlite committed at
`test/fixtures/replay-prod-db-synthetic.sqlite`. Regenerate after a schema.sql
drift:

```
cross-env NODE_OPTIONS=--experimental-sqlite \
  npx tsx scripts/eval/build-synthetic-replay-db.ts
```

## ReplayRow (one per line in `replay-output.jsonl`)

Field | Type | Notes
---|---|---
`sampleId` | string | mirrors `GoldLabel.sampleId`
`category` | number | 1..10 from `SampledRow.category`
`goldAct` | GoldAct | echo of gold
`goldDecision` | 'reply'\|'silent'\|'defer' | echo of gold
`factNeeded` | boolean | echo of gold
`allowBanter` | boolean | echo of gold
`allowSticker` | boolean | echo of gold
`resultKind` | 'reply'\|'sticker'\|'fallback'\|'silent'\|'defer'\|'error' |
`reasonCode` | string\|null | null iff error
`utteranceAct` | UtteranceAct | classifier output; `'none'` for non-reply
`guardPath` | string\|null | reply-path only; may be null
`targetMsgId` | string\|null | triggerMessage.messageId (not defer target)
`usedFactHint` | boolean\|null | reply only
`matchedFactIds` | number[]\|null | reply only
`injectedFactIds` | number[]\|null | reply only
`replyText` | string\|null | reply=text, sticker=cqCode, fallback=text, else null
`promptVariant` | string\|null | reply only
`violationTags` | string[] | 0..10 tags in declaration order
`errorMessage` | string\|null | error only
`durationMs` | number | diagnostic, not asserted

Wire invariant: `JSON.stringify` never emits `undefined`. Absent = explicit
`null`.

## ReplaySummary (`summary.json`)

Top-level keys: `generatedAt`, `runnerVersion`, `llmMode`, `goldPath`,
`benchmarkPath`, `totalRows`, `errorRows`, `silenceDeferCompliance`,
`violationCounts`, `violationRates`, `resultKindDist`, `utteranceActDist`,
`guardPathDist`, `reasonCodeDist`, `actConfusion`, `perCategory`.

Primary headline: `silenceDeferCompliance.rate` ∈ [0, 1]. Denominator =
rows where `goldDecision ∈ {silent, defer}` AND `resultKind !== 'error'`.
Compliant numerator = same rows where `resultKind ∈ {silent, defer}`.

## Violation tags (10; kebab-case; declaration order)

`gold-silent-but-replied`, `gold-defer-but-replied`, `direct-at-silenced`,
`fact-needed-no-fact`, `fact-not-needed-used-fact`,
`sticker-when-not-allowed`, `banter-when-not-allowed`, `object-react-missed`,
`meta-status-misclassified`, `target-mismatch`.

Predicate table: see `scripts/eval/violation-tags.ts` and `docs/specs/r6-3-DEV-READY.md` §6.3.

Per-tag denominators (`violationRates[tag].denominator`): rows included in
rate calculation per DEV-READY §6.5 / DESIGN-NOTE §2.1.

## Mock LLM (`--llm-mode mock`)

`MockClaudeClient` implements `IClaudeClient`. `complete(req)` returns
`"[mock:<hex8>] 好的"` where hex8 is the first 8 chars of
`sha1(system + '\n' + messages)`. Deterministic across runs. `inputTokens` =
`outputTokens` = 0 to push any usage-based branch in chat.ts into the
zero-tokens path. `realNetworkCalls` is const 0 — tests use this as a
tripwire.

`real` and `recorded` modes are reserved (exit 2). Wiring a real
`ClaudeClient` later is a one-liner — see `replay-runner-core.ts`.

## Known drifts (documented, not bugs)

1. `GroupMessage.role` defaulted to `'member'` — benchmark lacks role column.
2. `recentMessages.rawContent = content` — benchmark stores CQ-stripped
   `content` for context messages only. Trigger's `rawContent` is preserved.
3. `triggerContextAfter` not passed (generateReply only takes pre-context).
4. Scroll-back beyond 5 pre-context messages reads from the tmp-copy DB —
   fidelity requires `--group-id` to match the groupId the benchmark was
   sampled from (R6.1 used `958751334`).
5. Char-mode groups: `charModule` left unset. Samples that would take the
   `char` persona path fall through to the default.
6. `localStickerRepo`, `bandoriLiveRepo`, `embedder`, `visionService` all
   null — sticker-first, bandori-live, embedding, and vision paths not
   exercised. Documented.

## Zero-side-effect assertion

The integration test `test/eval/replay-runner-mock.test.ts` asserts
`sha256(synthetic fixture)` is unchanged before vs after a full run, and
`mockClaude.callCount > 0 && mockClaude.realNetworkCalls === 0`. Smoke
runbook (DEV-READY §10.3) also captures `sha256sum bot.db` before/after.

## Smoke baseline runbook

See `docs/specs/r6-3-DEV-READY.md` §10 (owner-runner runs the 20-sample
smoke, then post-merge the full 493-row baseline — artifacts gitignored).
