# R9 — Planner/Replyer-lite (MUCA-style constraint layer)

> Status: Phase 1 / Planner / 2026-05-05
> Worktree: `.claude/worktrees/r9-replyer-lite/` on `feat/r9-replyer-lite` (master `3897126`)
> Naming note: briefing referenced `docs/product-specs/`; the actual repo convention is `docs/specs/` (mirrors r2-5-PLAN.md, r6-3-PLAN.md, etc.) — this file follows the existing convention.

## Why now

Per `docs/eval/metrics-baseline-runbook.md` (post-#155 baseline) the post-merge real-LLM 781-row benchmark surfaced:

- `fact-needed-no-fact`: 2.0% (16/781). Post-#153 alias gap closed *retrieval*, but the replyer still occasionally elects to play 装傻 / reverse-question even when a fact block is present in the prompt. Root cause is not retrieval — it is that the single-LLM reply call balances "groupmate persona" vs "use the fact" in one shot and sometimes loses.
- `repeated-low-info-direct-overreply`: rising at the silence-success denominator (R2.5 SF1 dampener visible). When the dampener doesn't fire (fresh user, novel surface tokens) the LLM rambles 2-3 sentences on a low-info trigger because nothing in-prompt instructs "ack-length only".
- Replyer-tone divergence from group voice: post-#155 spot-checks show the replyer trending earnest/explanatory when groupmate-voice samples (live raw few-shot) point clearly toward terse/sticker-leaning shapes.

These three failure modes share a root cause: a **single LLM call** is asked to (a) decide *what* to say (mode, length, whether to use facts, whether to skip), (b) decide *how* to say it (tone, vocabulary, sticker token), and (c) honor every guard simultaneously. When (a) and (b) tradeoffs collide, (b) wins because the prompt is groupmate-voice-heavy and "facts > 装傻" is a single hardened rule that's drowned by 20+ other style cues.

R9 separates those concerns into two LLM passes:

1. **Planner** — small, fast call that reads the trigger + minimal context + retrieved facts and emits a structured **Directive** (mode / length / required facts / forbidden tokens / tone hint).
2. **Replyer** — the existing `chatRequest` call, but now constrained by the Directive (added as a structured block above persona/voice noise) and asked only to *compose*, not to decide.

This is the "MUCA" pattern in the R7 runbook ([metrics-baseline-runbook.md:181](../eval/metrics-baseline-runbook.md)): **M**ulti-**U**tterance **C**onstraint-**A**ware replying. No public reference doc exists in this worktree (grep across worktree finds the term only in the runbook + this PLAN); I infer the semantics from the name + "constraint layer" framing in the runbook + briefing. If a canonical academic reference exists, Designer is welcome to cite it; the pattern itself (planner→replyer) is the load-bearing piece.

## Current reply path (single-LLM, for the trace)

`src/modules/chat.ts`:

- Entry: `generateReply` `chat.ts:1641-1680` → wraps `_generateReplyImpl` and records direct-cooldown / clears @-spam.
- Core: `_generateReplyImpl` `chat.ts:1682-3320+`:
  - Pre-LLM gates: debounce / rate-limit / classify-path / engagement-decision / fact retrieval / on-demand-lookup (Path A) / web-lookup (Path C).
  - Prompt assembly `chat.ts:2480-3008`:
    - wide / medium / immediate context sections `chat.ts:2482-2505`
    - v1 systemPrompt = `_getGroupIdentityPrompt(...)` `chat.ts:2508`
    - mood / sticker-token / voice / style / affinity / addressing blocks `chat.ts:2513-2998`
    - variant block (P3-2) `chat.ts:2884-2887`
    - facts / on-demand / web-lookup / expression-late / few-shot-late blocks `chat.ts:2940-2967`
    - `userContent` assembled `chat.ts:3001-3004`
    - hardened fact-priority rule `chat.ts:3006-3008`
    - R5 v2 systemPrompt (flag-gated, currently default OFF) `chat.ts:3010-3042`
  - Single LLM call: `chatRequest` factory `chat.ts:3044-3069`, invoked at `chat.ts:3074`. `system: [...]` passes ~10 cached blocks; `messages: [{ role: 'user', content: userContent }]`.
  - Post-LLM: sentinel + regen loop + scope-claim guards + self-echo guard + template-family cooldown + entity guard + sticker-token resolver `chat.ts:3077-3300+`.

R9 inserts a **second LLM call BEFORE** `chatRequest()` at `chat.ts:3044` — output is a `Directive` object surfaced into the Replyer prompt and into post-LLM verification only as **soft observability** (no veto in Lite scope; see Scope OUT).

## Trigger metrics + acceptance threshold

Per `metrics-baseline-runbook.md` "Behavior-layer next decision: R4.5 vs R9" section, R9 is the right choice when `fact-needed-no-fact` persists post-#153 / `repeated-low-info-direct-overreply` rises / replyer tone diverges. All three currently signal.

Acceptance for R9 Phase 5 (Reviewer APPROVED gate):

- [ ] Real-LLM 781-row replay: `fact-needed-no-fact` ↓ ≥ 1pp absolute (2.0% → ≤ 1.0%) — low-variance metric per runbook §"Metric variance discipline" so single-run signal acceptable, but Reviewer SHOULD run twice to confirm.
- [ ] Real-LLM 781-row replay: `repeated-low-info-direct-overreply` rate (silent-bucket denominator) ↓ ≥ 1pp absolute OR rate of `direct-at-silenced-by-guard` ↓ measurably without `fact-needed-no-fact` regressing.
- [ ] No regression > 0.5pp on: `direct-at-silenced` aggregate, `direct-at-silenced-by-guard`, `gold-silent-but-replied`, `target-mismatch`, `meta-status-misclassified`, `bot-not-addressee-replied`, `self-centered-scope-claim`.
- [ ] tsc clean. Full vitest suite green (`npm run test`).
- [ ] Edge tests (see §"Edge cases") covered with first-class test files.
- [ ] p99 chat-turn latency increase ≤ 1.2× current baseline (Planner is a small Flash call; should be < 800 ms p99). Logged via existing `ms_claude` log line — Reviewer reads from background-mode logs.
- [ ] Cost: incremental Planner spend ≤ 0.3× existing Replyer spend per turn (small input, ≤200 token output). Reviewer confirms via `summary.json` from real-LLM replay.

High-variance metrics (`sticker-when-not-allowed`, `banter-when-not-allowed`, `meta-status-misclassified`) are **observed**, not gated, per runbook §"Metric variance discipline" — only treated as regression on multi-run confirmation.

## MVP split: Planner emits Directive, Replyer composes

### Planner

- **Input**: trigger content + sanitized nickname, immediate-thread compact context (≤ 6 lines, raw not formatted), retrieved fact summary (term → meaning pairs only, no raw payload), pre-computed gate signals already on the path (`isAtTrigger`, `isReplyToBot`, `hasRealFactHit`, `utteranceAct`, `dNonBot`, `affinity factor`, `directCooldown.isInWindow`).
- **Model**: Gemini 2.5 Flash (cheap, fast, already wired via `ai/providers/gemini-llm.ts`). Reasoning effort `'none'` per `feedback_gemini_thinking_budget` / `feedback_gemini_reasoning_effort_eos`.
- **Output**: structured JSON-ish `Directive` (Designer to lock exact schema, Phase 2). Suggested fields:
  - `mode`: `'silent' | 'ack' | 'reply' | 'sticker_only' | 'fact_answer'`
  - `lengthBudget`: `'≤3char' | 'short' | 'normal'` (≤ 30 / ≤ 80 / ≤ 200 chars; numeric ranges in Designer spec)
  - `requiredFactIds`: `string[]` — fact-IDs the Replyer MUST surface (drawn from `matchedFactRetrievalIds` in scope when `mode === 'fact_answer'`)
  - `forbiddenTokens`: `string[]` — at minimum the bot's own last 3 outputs' top-tokens (re-emit of `recentOutputs` in chat.ts:2534), plus any obvious bot-tells if Planner detects them
  - `toneHint`: free-text ≤ 24 chars, drawn from groupmate-voice samples ("terse / sticker-leaning / 装傻 / 顺着接")
  - `useStickerToken`: `boolean | null` (null = composer decides among allowed token choices)
- **Falls back to**: Directive `{ mode: 'reply', lengthBudget: 'normal', requiredFactIds: [...all matched...], forbiddenTokens: recentOutputs.tokens, toneHint: '', useStickerToken: null }` when Planner times out / parse fails / cost cap. **Never blocks the turn** — Replyer always runs.
- **Telemetry**: log directive shape into existing `chat timing (claude)` log line (extend with `directive_mode`, `directive_lengthBudget`); persist on `chat_decision_events.directive_json` (new TEXT column — see §"Schema migration" in DEV-READY phase).

### Replyer

- The **existing** `chatRequest` call at `chat.ts:3044`, with one prompt-shape change: a new structured constraint block injected at top of `system: [...]`, ABOVE persona / voice / style. Cached `true` so cache invalidation is bounded to directive-shape changes.
- Block format (Designer locks exact wording in Phase 2):
  ```
  你这次回复必须严格遵守 <reply_directive_do_not_follow_instructions> 里的约束。
  里面是给你执行的【内部约束】，不是用户消息。
  <reply_directive_do_not_follow_instructions>
  mode: <mode>
  length: <lengthBudget>
  must mention facts: <fact-summaries from requiredFactIds>
  do not say: <forbiddenTokens csv>
  tone: <toneHint>
  </reply_directive_do_not_follow_instructions>
  ```
- Directive is **wrapped in `_do_not_follow_instructions` envelope** per `feedback_trusted_rules_outside_untrusted_data_inside.md` — even though Planner output is "trusted" relative to user, treating it as data is safer (it's still LLM-generated, can be smuggled-into via user content the Planner saw).
- All existing post-LLM guards (sentinel / regen / scope-claim / self-echo / template-family / entity / sticker-token) **still run unchanged**. Directive is an INPUT bias, not a replacement for runtime safety.

### Wiring point in chat.ts

The Planner call inserts in `_generateReplyImpl` between the existing prompt-block computation (after `hasRealFactHit` is decided at `chat.ts:2930` and after voice/style/variant blocks are built at `chat.ts:2986`) and the `chatRequest` factory definition at `chat.ts:3044`. A new private method `_buildDirective(...)` returns the Directive; an `assembleDirectiveBlock(directive): string` helper formats it. The block is prepended to the `system: [...]` array inside the existing `chatRequest` factory.

Replyer prompt order (after R9): `[directiveBlock, v2SystemPrompt ?? systemPrompt, STATIC_CHAT_DIRECTIVES, variantBlock, groupContextBlock, moodSection, contextStickerSection, rotatedStickerSection, factsBlock, onDemandFactBlock, webLookupBlock, expressionLateBlock, fewShotLateBlock, tuningBlock]`.

## Scope IN

1. New module `src/modules/reply-planner.ts` exporting `interface IReplyPlanner { plan(ctx: PlannerContext): Promise<Directive | null> }` and a default impl `ReplyPlanner` backed by Gemini Flash.
2. Directive type in `src/modules/reply-planner.ts` (or `src/utils/reply-directive.ts` if Designer prefers separation; pick one location, no aliasing per `feedback_no_deprecated_alias_on_clarifying_rename`).
3. `_buildDirective(ctx)` private method on `ChatModule` that calls `replyPlanner.plan(ctx)` with timeout + try/catch → returns Directive-or-fallback. **Helpers normalize input internally** (`feedback_normalize_inside_helper`) — caller passes raw fields; helper trims/sanitizes before LLM call.
4. Directive block injected into existing `chatRequest` factory `system: [...]` array at `chat.ts:3044`.
5. Lightweight runtime check post-Replyer-LLM: log (don't veto) when Replyer output appears to violate `lengthBudget`/`forbiddenTokens` — observability only, feeds Phase 6+ decision on whether to add veto-and-regen.
6. Schema migration: ALTER TABLE `chat_decision_events` ADD COLUMN `directive_json TEXT`. Update `src/storage/schema.sql` to include it on fresh installs (per `feedback_sqlite_schema_migration`).
7. Feature flag `chat_planner_lite_v1` in `group_config` (DEFAULT 0). Path is wired but inert until flag flipped per group. Default OFF for staged rollout.
8. Edge tests (see §Edge cases below) — first-class test files under `test/modules/reply-planner.test.ts` and `test/chat-planner-integration.test.ts`.
9. Real-LLM benchmark run + comparison snapshot before/after. Reviewer Phase 5 produces this.

## Scope OUT

Per briefing — keep R9 *Lite*. The following are deferred:

- **Full agentic loop** — no Planner→Replyer→Verifier→Re-plan ladder. One Planner call, one Replyer call, no dynamic retry on directive-violation.
- **Multi-turn planning** — Planner sees only the current turn's context window. No state carried across turns beyond what's already on chat.ts via `conversationState` / `directCooldown` / `selfEchoGuard`.
- **Retry-on-veto** — if Replyer output violates Directive constraints (e.g. exceeds lengthBudget, contains forbiddenToken), R9 Lite **logs the violation and ships the reply anyway**. Existing post-LLM guards (sentinel etc) still veto on safety-class issues. A future R9.1 can add directive-veto-and-regen if telemetry shows it's needed.
- **Reactive re-planning** — Planner runs once. No refresh on guard regen.
- **Tool-calling Planner** — no "plan then call fact-retrieval" agentic path. Fact retrieval is upstream; Planner sees results.
- **R8 legacy cleanup** — `_getGroupIdentityPrompt` stays; `expression_patterns` table stays. R8 is gated separately on R5 canary stability.
- **Touching R5 prompt-assembler v2** — flag-gated, default off, R9 layers on top of it via `v2SystemPrompt ?? systemPrompt`. The directive block sits ABOVE v1/v2 either way.
- **Touching R4-lite utterance-act classifier** — Planner *consumes* `utteranceAct` as input. R4.5 (separate workstream, task #5) replaces the classifier internals; R9 only depends on the value being present.
- **Char mode behavior changes** — directive applies the same way; Planner does NOT attempt to switch persona. Persona is upstream config.
- **Private DM path (`generatePrivateReply`)** — out of scope. R9 is group chat only. PrivateReply path at `chat.ts:4275-4310+` untouched.
- **Replacing existing post-LLM guards** — they all still run.

## Edge cases (mandatory, per `feedback_edge_testing_soul`)

Designer/Architect/Developer must cover ALL of these:

1. **Planner timeout / 429 / parse-fail** → Replyer runs with fallback Directive; turn ships normally; no user-visible degradation. Test by mocking Planner to throw.
2. **Planner returns `mode: 'silent'` but turn was triggered by a direct `@bot`** → Directive value is **discarded** for `mode` (forced to 'reply' or 'fact_answer'); other Directive fields still apply. Direct @ MUST get a reply per existing `chat.ts:3306-3315` fallback path. Justification: Planner can't override fundamental "@-bot must respond" contract; `lengthBudget` and `forbiddenTokens` still help.
3. **`mode: 'fact_answer'` + `requiredFactIds: []`** (Planner says fact-answer but no facts retrieved) → degrade to `mode: 'reply'` with toneHint preserved.
4. **`forbiddenTokens` contains a token that is the literal user trigger word** (e.g. user says "烦死了" → Planner forbids "烦") → Replyer is allowed to echo-quote the user; existing self-echo-guard handles re-fire. Test the directive does NOT prevent legitimate user-quote replies.
5. **`lengthBudget: '≤3char'` on a fact-grounded direct question** → degrade to `'short'` (≤ 80 chars). Fact answers don't fit in 3 chars; this is the existing `hardenedFactPriorityRule` (chat.ts:3006) generalized.
6. **Planner Chinese-character typo in toneHint** (`feedback_chinese_character_typos_in_prompts`) → caps toneHint length to 24 chars, logs raw value, doesn't crash. Plain string passthrough; no parsing of toneHint.
7. **Directive parse drift** — Planner returns malformed JSON (e.g. trailing comma, unquoted key). Validator at boundary (`feedback_validator_at_every_boundary`): use a tolerant parser (try strict → try forgiving fallback → return null) → null → fallback Directive. Test with 5+ malformed shapes.
8. **Feature flag OFF** (`chat_planner_lite_v1 = 0`) → Planner path skipped entirely; behavior byte-identical to pre-R9. Verified by snapshot diff on flag-off rows.
9. **Bot-triggered turn** (`triggerMessage.userId === botUserId`, e.g. proactive engine echo path) → skip Planner entirely; Replyer runs as today. Bot talking to self has no "groupmate voice" target.
10. **Cost-cap during Planner call** → Planner falls back; no cost-cap event recorded as PR-of-record (the Replyer call's cost-cap remains the gate).
11. **CJK regex compaction in forbiddenTokens** (`feedback_cjk_compact_whitespace_match`) — token comparison normalizes `\s+ → ''`, NOT collapseWs.
12. **`requiredFactIds` references fact that's no longer in factsBlock** (e.g. retrieved but pruned by token budget upstream) → Planner directive is silently downgraded; log a warning. Don't pretend a missing fact is in scope.
13. **Affinity-low / hostile user trigger** (`affinity factor < 0.3`) → Planner sees factor, may emit `mode: 'silent'` even on at-bot. Per edge case #2 this is **overridden** to ack/reply on direct @. The hostility is handled by existing scope-claim/self-echo guards; R9 doesn't add a new "ignore hostile user" path.
14. **Repeated-low-info trigger when SF1 dampener already fired** — Planner runs ONLY when chat reaches the LLM stage. SF1 short-circuits before that (silent / ack output). No double-handling.
15. **Sticker-only group state** — when stickers are not allowed in this scene (sticker-allowed flag false), `useStickerToken: true` is downgraded to null inside the directive validator.

## Open questions for Designer

1. **Directive serialization in prompt** — JSON-in-tag (machine-parseable) vs natural-language list (smaller token cost, less fragile)? Lean natural-language because Replyer is reading not parsing; JSON adds ~40 tokens of brace/quote overhead with no parser on the receiving end.
2. **`lengthBudget` enum vs char-count integer** — three buckets (≤3 / short / normal) is enough for current metrics; integer flexibility might overfit. Recommend enum.
3. **`forbiddenTokens` source** — bot's `recentOutputs` (chat.ts:2534) + Planner-detected bot-tells. Is Planner reliable enough to detect bot-tells? Or should we hardcode a small bot-tell blocklist? Suggest: hardcode + Planner can append.
4. **Directive cache key** — does the directive block invalidate the system-prompt cache every turn (because `recentOutputs` change)? Probably yes — moving directive block to `cache: false` first slot is cleaner than letting it bust the cached blocks below it. Designer to confirm with prompt-cache structure.
5. **Schema for `chat_decision_events.directive_json`** — full Directive object as JSON, or top-level keys flattened? Flat is more queryable for offline analysis; JSON keeps schema flexible. Suggest flat top-level + raw JSON column for debugging.
6. **Standing rule check** — `feedback_embed_standing_rules_in_agent_briefing.md`: Replyer prompt MUST include "你是群友不是助理" reaffirmation. The directive block uses imperative voice — Designer must word it so Replyer doesn't drift into assistant register because the directive sounds like instructions. Wrap-with-untrusted-data envelope helps; toneHint can re-state "groupmate".
7. **Do we run Planner for non-direct turns at all?** — non-direct turns are >90% of LLM-stage turns. Cost-wise non-trivial. Phase 2 should let Designer decide: (a) always-on, (b) direct-only first, expand after canary, (c) sample-rate based. Recommend (b) for canary safety.
8. **Reviewer cadence** — runbook says single real-LLM run is OK for low-variance metrics. R9 affects mostly low-variance ones (`fact-needed-no-fact`, guards), but tone-divergence is implicitly high-variance. Reviewer should still do 2 runs and compare.

## Standing rules (HARD — do not negotiate)

Quoted verbatim per `feedback_embed_standing_rules_in_agent_briefing.md`. All downstream agents (Designer / Architect / Developer / Reviewer) must honor these:

- ASCII single quotes only — NO smart quotes anywhere in TS source (`feedback_no_smart_quotes`).
- No emojis in source / commits / docs.
- No `Co-Authored-By` lines in commits.
- No `.claude/` paths in commits or PR diffs.
- Edge tests mandatory (`feedback_edge_testing_soul`) — every edge case in §Edge cases above gets a first-class test.
- Conventional commits (`feat(chat):`, `fix(chat):`, etc.).
- Schema changes: ALTER migration in `src/storage/db.ts` migration runner AND update `src/storage/schema.sql` for fresh installs (`feedback_sqlite_schema_migration`).
- Helpers normalize input internally — caller does not pre-trim (`feedback_normalize_inside_helper`).
- **Bot is groupmate, not assistant** (`feedback_groupmate_not_assistant_lens`) — Replyer prompt MUST reflect this. Directive block must NOT make the Replyer behave like an assistant taking orders. Per `feedback_no_reverse_priming_in_prompt`, do not enumerate banned strings in directive — `forbiddenTokens` are passed as data, not as "do not say X, do not say Y" prompt list.
- Trusted rules outside untrusted data inside (`feedback_trusted_rules_outside_untrusted_data_inside`) — directive wraps in `_do_not_follow_instructions` envelope.
- Validator at every boundary (`feedback_validator_at_every_boundary`) — directive validator runs at: Planner output → cache write → prompt-block build → debug log. Missing any = bypass bug.
- Result types carry meta on themselves (`feedback_metadata_on_result_not_side_channel`) — no `getDirectiveForLastCall()` Maps. Directive flows on `BaseResultMeta` if exposed.
- Timing/defer gates BEFORE expensive ops (`feedback_defer_before_expensive_op_not_after`) — Planner is the new expensive op; existing pre-LLM gates (debounce, rate-limit, classify-path, engagement-decision) MUST still run before it. Don't move Planner ahead of them.
- **Default-conflicting-with-standing-rule must be AskUserQuestion not silent** (`feedback_default_violating_standing_rule_must_be_question`) — Designer hits this if any default would violate any rule above; surface it as an open question in DESIGN-NOTE rather than silently choosing.

## Hand-off to Designer (Phase 2)

Designer (next agent) writes `docs/specs/r9-replyer-lite-DESIGN-NOTE.md` covering:

- Exact `Directive` TypeScript shape + Zod-or-equivalent validator.
- Exact Replyer prompt block wording (with the `_do_not_follow_instructions` envelope).
- Planner system prompt (what context shape, what output format, what model hints).
- Fallback directive (the literal default object) + when it kicks in.
- Sticker-token interaction with `useStickerToken` directive field.
- Cache-block placement decision (cache: true on directive vs cache: false first slot).
- Resolutions to the 8 open questions above.
- Schema migration SQL (DDL) ready for Architect to translate into migration runner code.

Architect (Phase 3) then writes DEV-READY with: file diff plan, test file list, exact test cases per edge, telemetry log lines, schema migration code, feature flag wiring code, rollout sequence (default-off → flip on group 958751334 first → measure 48h → wider).

Developer (Phase 4) implements + commits. Reviewer (Phase 5) runs full test suite + real-LLM benchmark + APPROVED gate.
