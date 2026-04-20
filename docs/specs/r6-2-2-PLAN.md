# Feature: R6.2.2 — Pretty-Print CQ + Sampler Context Raw Backfill

## Product Context

R6.2.1 merged CQ display support into the gold-label CLI — `renderer.ts` now reads `rawContent` on the trigger row and shows it instead of the stripped `content`. That unblocked labelers for direct `@bot` media rows, but the CLI still fails on two real cases surfaced during first-hour labeling on `data/eval/r6-1c/benchmark-weak-labeled.jsonl`:

1. **Raw hex file IDs bury captions.** A row like `[CQ:image,summary=&#91;动画表情&#93;,file=4d8a...]` is 120+ chars; after `truncate(..., 60)` the caption is cut and the labeler sees only `[CQ:image,summary=&#91;动画表情&#93;,file=4d...` — worse than the pre-R6.2.1 placeholder.
2. **Context rows are still stripped.** `fetchContext` in `scripts/eval/sample-benchmark.ts` only SELECTs `content`, so `ContextMessage` has no `rawContent` column. The reader (`gold/reader.ts::mapContextMessage`) already falls back to `rawContent ?? content`, but the field is never produced upstream, so prior/after rows in the CLI show `(empty)` whenever the message was media-only.

R6.2.2 fixes both in one change: a display-only pretty-printer that collapses CQ noise into short human-readable tags, and a sampler-level backfill that carries `rawContent` through context rows so the pretty-printer has something to display.

Source changes are **script/CLI only**. No `src/` runtime code is touched — the LLM prompt path, NapCat adapter, and message repo all keep their current CQ handling.

## User Stories

- As a human labeler, I want captioned images to show as `[img:动画表情]` instead of `[CQ:image,summary=&#91;动画表情&#93;,file=...]`, so the caption survives the 60-char truncate.
- As a human labeler, I want `@bot` to render as `[@bot]` and other `@`s as `[@user:<qq>]`, so I can instantly see who a message was addressed to.
- As a human labeler, I want context rows (the 5 before / 3 after the trigger) to also show pretty-printed CQ, so I can judge relay / object-react / media-chain patterns without re-querying the DB.
- As a pipeline maintainer, I want old `benchmark-weak-labeled.jsonl` files (no `rawContent` in context) to still load, so we don't have to re-run the sampler before shipping the display fix.

## Acceptance Criteria

- [ ] `scripts/eval/gold/pretty-cq.ts` exports `prettyPrintCq(rawContent: string, botQQ: string | null): string`
- [ ] Unit tests in `test/eval/gold-pretty-cq.test.ts` cover every CQ code listed in the mapping table below, plus HTML-entity decode, plus unknown-CQ passthrough
- [ ] `prettyPrintCq("[CQ:image,summary=&#91;动画表情&#93;,file=abc123]", null)` returns `"[img:动画表情]"`
- [ ] `prettyPrintCq("[CQ:at,qq=1705075399] 请我喝奶茶", "1705075399")` returns `"[@bot] 请我喝奶茶"`
- [ ] `prettyPrintCq("[CQ:at,qq=999] hi", "1705075399")` returns `"[@user:999] hi"`
- [ ] `renderer.ts` calls `prettyPrintCq` on both trigger row (`rawContent ?? content`) and every `contextBefore` / `contextAfter` row, then truncates to 60 chars
- [ ] `sample-benchmark.ts::fetchContext` SELECTs `raw_content` alongside `content`; returned `ContextMessage` objects include `rawContent: string | null`
- [ ] `scripts/eval/types.ts::ContextMessage` interface gains `rawContent: string | null`
- [ ] `gold/reader.ts::mapContextMessage` already handles missing `rawContent` (R6.2.1) — no regression; add a test that covers an old-schema context row (no `rawContent` key) and asserts it falls through to `content`
- [ ] `test/eval/sample-benchmark.test.ts` context fixture gets `raw_content` column; assertion that output `ContextMessage` carries the raw value
- [ ] `pnpm run typecheck` and `pnpm run test` both green in the worktree
- [ ] No `src/` files modified; diff is scoped to `scripts/eval/`, `test/eval/`, `docs/specs/`

## Scope — Two Halves

### Half A: CLI renderer pretty-print

New helper `scripts/eval/gold/pretty-cq.ts`:

- Pure function, no I/O. Signature `(rawContent: string, botQQ: string | null) => string`.
- Runs a single regex scan replacing each `[CQ:...]` segment with its pretty form (see Designer mapping table for exact outputs). Non-CQ text is preserved.
- HTML entity decode (`&#91;` `&#93;` `&amp;`) runs AFTER CQ replacement, on the full output string — so entity-encoded brackets inside `summary=` are surfaced as literal `[` `]` in the caption.
- Unknown CQ codes fall through as `[cq:<type>]` (no params) — never pass raw hex through.

Wire into `renderer.ts` at the three places today's code calls `truncate(m.rawContent ?? m.content, 60)` (lines 83, 87, 92). Pretty-print FIRST, then truncate.

### Half B: Sampler context raw backfill

- `fetchContext` query adds `raw_content` to the SELECT list on both `before` and `after` branches.
- Row-mapper produces `{ id, userId, nickname, content, rawContent, timestamp }`.
- `scripts/eval/types.ts::ContextMessage` gains `rawContent: string | null` (non-optional to force callers to address it).
- `test/eval/sample-benchmark.test.ts` fixture tables already have a `raw_content` column (verified — see line 222, 369, 608 etc. on `SampledRow.rawContent`), but the in-memory schema for the context-fetching test needs it too; add one assertion that an image-only row is carried through.
- `weak-label.ts` and `summary.ts` read `ContextMessage.content` only — confirmed no callers break on the added field.

## Out of Scope

- LLM-aware pretty-print (e.g. resolving `[CQ:reply,id=N]` into the actual replied-message preview). Current task renders `[reply:N]` literally.
- Nickname resolution for `[CQ:at,qq=N]` non-bot targets — stays as `[@user:N]`.
- Re-running the sampler against the real DB to produce an updated `benchmark-weak-labeled.jsonl`. User will run that themselves after merge — R6.2.1's existing file keeps working via the reader fallback.
- Any `src/` runtime change (prompt builder, message repo, NapCat adapter). The bot's own CQ handling is a separate concern.

## Downstream Handoff

- **#2 Designer** produces the exact CQ → pretty-tag mapping table (covering every CQ type seen in `data/eval/r6-1c/benchmark-weak-labeled.jsonl`: `image`, `mface`, `face`, `at`, `reply`, `video`, `record`, plus passthrough rule) and the HTML-entity decode list.
- **#3 Architect** writes `r6-2-2-DEV-READY.md` specifying the file paths, function signatures, test-case list (include `prettyPrintCq("")` edge case, multi-CQ in one message, mixed-with-text), and type changes.
- **#4 Developer** implements per DEV-READY; must write tests first; must keep src/ untouched.
- **#5 Reviewer** runs `pnpm run typecheck` + `pnpm run test`, spot-checks CLI render against three sample JSONL rows including a captioned image, a multi-`@` row, and an old-schema context row with no `rawContent`.
