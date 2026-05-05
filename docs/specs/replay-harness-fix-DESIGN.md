# Replay-Runner Harness Fix — DESIGN

**Phase**: Designer (task #33)
**Branch**: `fix/replay-runner-r9-planner-wire`
**Worktree**: `.claude/worktrees/replay-harness-fix/`
**Master parent**: `6449849`
**Inputs**: `replay-harness-fix-PLAN.md`, `.claude/code-reviews.md` R9.5 section, `scripts/eval/replay-runner-core.ts`, `src/index.ts:629-637`, `src/modules/reply-planner.ts`, `src/config/reply-planner.ts`, `src/modules/chat.ts:1664-1667 + 3151-3290`, `scripts/eval/replay-types.ts`, `test/chat-planner-integration.test.ts`, `test/eval/replay-runner-mock.test.ts`.

This DESIGN locks every wiring shape, type, mock-LLM strategy, and test-matrix expectation Architect (task #34) needs to produce a verbatim diff. No new behavior introduced; harness becomes able to exercise the R9 directive layer when the env flag is on, and stays byte-identical when it is off.

---

## 1. Decisions on PLAN open questions

### 1.1 Q1 — ReplyPlanner construction shape (PLAN §6.1 Q1)

**Decision**: Reuse `args.mockClaude` as the `IClaudeClient` for `ReplyPlanner`. ONE LLM client per harness run. NO separate `GeminiClient` constructed inside `constructChatModule`.

**Justification**:
- PLAN §2.1 line 41 + §2.3 line 68 already lock this. Designer confirms: in real-LLM mode `args.mockClaude` is `RealClaudeClientForReplay` which already wraps Gemini OpenAI-compat with cost cap + 429/5xx retry + RPS limiter. Bypassing it would re-introduce R9.5 review's `CHAT_MODEL=gemini-2.5-flash` env divergence and double the live-LLM cost.
- In mock mode `args.mockClaude` is `MockClaudeClient` (deterministic sha1-based stub) — same client correctly drives both the chat call and the planner call, with system-prompt-based mock-routing distinguishing them (see §1.4 below).
- `ReplyPlanner.constructor(llm: IClaudeClient, logger: Logger, opts?: ReplyPlannerOptions)` takes `IClaudeClient` directly (`src/modules/reply-planner.ts:593-602`); no shape mismatch.

### 1.2 Q2 — Test access shape (PLAN §6.1 Q2)

**Decision**: **Option C** — `constructChatModule` returns `{ chat, db, replyPlanner }` (planner in the third slot). Tests assert on the returned tuple. NO chat.ts edit. NO TypeScript-side bracket access.

**Justification**:
- PLAN default tilt confirmed.
- Most surgical to chat.ts: zero LOC delta there.
- Decouples test from `ChatModule._replyPlanner` private field name (Option B's brittleness).
- Avoids adding a public `getReplyPlanner()` getter to ChatModule (Option A) — getters expand the public surface for a thing only the harness owner needs to inspect; production code never asks ChatModule for its planner back.
- The harness internally still calls `chat.setReplyPlanner(plannerInstance)` AFTER construction — same production pattern (`src/index.ts:633`). The returned `replyPlanner` reference is just an additional handle for tests; ChatModule still owns its mutable field.

**Return-shape impact**: `constructChatModule` already returns `{ chat: ChatModule; db: Database }` at `replay-runner-core.ts:62`. New shape is `{ chat: ChatModule; db: Database; replyPlanner: IReplyPlanner | null }`. The single existing caller is `replay-runner.ts:298-302` which destructures only `chat, db` — non-breaking; ignored field is fine in TypeScript object destructuring.

### 1.3 Q3 — `plannerSource` surface (PLAN §6.1 Q3)

**Decision**: **Strategy 1** — extend `ReplayRow` with a `plannerSource` field. NO side-channel Map. NO log-only.

**Justification**:
- PLAN default tilt confirmed.
- Per `feedback_metadata_on_result_not_side_channel`: result types carry meta on themselves; no `getXForLastCall()` Maps. Strategy 2 (DB-side query in tests) is the side-channel pattern this rule rejects.
- One-field projection in `buildReplayRow` (already a single source of truth for ReplayRow shape per `replay-runner-core.ts:92-217`). Permanent additive telemetry: zero downstream churn (the summary aggregator iterates known tag keys, not all fields, per PLAN §7 risk row 4).
- Permanent value beyond this PR: task #37 (R9.4 re-baseline) and any future R9.x tuning iteration get a free `grep "plannerSource"` audit channel on `replay-output.jsonl`.

**Final TypeScript shape**:

```ts
// scripts/eval/replay-types.ts — added to ReplayRow interface, between
// "violationTags" and "errorMessage" (logical "diagnostics" grouping)
plannerSource: 'llm-planner' | 'rule-fallback' | 'no-planner-skipped' | null;
```

**Null semantics — non-ambiguous reading**:
- `null` reserved for `resultKind === 'error'` rows. ChatResult never returned, no `meta` exists, no planner branch was reached. The runner caught the throw at `runReplayRow` `try/catch`.
- `'no-planner-skipped'` — the literal string from chat.ts:3177, set in three branches: env flag OFF, bot-self trigger, scope-skipped. ChatResult.meta DID return; planner just did not run.
- `'llm-planner'` — chat.ts:3230 — Planner returned a Directive AND validateDirective accepted it.
- `'rule-fallback'` — chat.ts:3240 — Planner returned null (parse fail / validate fail / timeout / throw) AND chat.ts overlaid `buildFallbackDirective` for the directive block.

Reviewer note: `null` is NOT "skip". A row with `plannerSource: null` indicates the harness or upstream chat path errored before the planner branch could be evaluated. T-3b asserts the `'no-planner-skipped'` literal explicitly, NOT `!== 'llm-planner'` — the latter would silently pass on null-rows.

### 1.4 Q4 — Logger choice (PLAN §6.1 Q4)

**Decision**: Use `createLogger('reply-planner-replay')` (same `createLogger` factory as production at `src/index.ts:633`, but a distinct name suffix `-replay` so log greps can separate harness-emitted planner logs from the production-bot's planner logs in mixed log streams).

**Justification**:
- Parallel to production via shared factory.
- `-replay` suffix is harmless metadata that future Reviewer will appreciate when triaging cost-cap halts in `replay-output/run.log`.
- Tests can ignore the log noise (existing `chat-planner-integration.test.ts` does — it calls `initLogger({level:'silent'})` at top, and the harness path will inherit that when run inside vitest).

### 1.5 Resolution of env-load timing tension (Designer-introduced; team-lead approved Option B)

**Decision**: Add a lazy function `isReplyerLiteEnvOn(): boolean` to `src/config/reply-planner.ts`; **delete** the `R9_REPLYER_LITE_ENV` const. The function reads `process.env['R9_REPLYER_LITE_ENABLED'] === '1'` on every call (parallels `isReplyerLiteEnabled(groupConfig)` lazy-call shape that chat.ts already uses).

**Why this is necessary** (NOT in original PLAN):

`R9_REPLYER_LITE_ENV` at `src/config/reply-planner.ts:13-14` is a **module-load-time const**. It captures `process.env['R9_REPLYER_LITE_ENABLED']` exactly once, when the file is first imported. Implications:

| Caller | Captures env when? | Outcome |
|---|---|---|
| Production `npx tsx scripts/eval/replay-runner.ts` (env set in shell) | Before Node starts; const captures `'1'` correctly | Wire works |
| Vitest test that does `process.env['R9_REPLYER_LITE_ENABLED']='1'` in `beforeEach` | After vitest already loaded reply-planner.ts; const captured `undefined` | False-negative wires; T-1 / T-3 / T-3c silently fail |

The existing `chat-planner-integration.test.ts` sidesteps this by using **per-group `chatPlannerLiteV1: true` in DB** (file:69). That works only because `isReplyerLiteEnabled(groupConfig)` is a lazy function call. The new harness wire fires at `constructChatModule` time, before any group config is in scope, so it cannot use the per-group bypass.

**Resolution** (team-lead approved 2026-05-05 message thread):

Edit `src/config/reply-planner.ts`:

```ts
// BEFORE (lines 13-14):
export const R9_REPLYER_LITE_ENV =
  process.env['R9_REPLYER_LITE_ENABLED'] === '1';

// AFTER:
export function isReplyerLiteEnvOn(): boolean {
  return process.env['R9_REPLYER_LITE_ENABLED'] === '1';
}
```

And update the one internal caller `isReplyerLiteEnabled` (file:20) to call `isReplyerLiteEnvOn()` instead of reading the const.

**Grep evidence for safe deletion**:

```
$ grep -rn "R9_REPLYER_LITE_ENV\b" src/ scripts/ test/
src/config/reply-planner.ts:13:export const R9_REPLYER_LITE_ENV =
src/config/reply-planner.ts:20:  return R9_REPLYER_LITE_ENV;
```

Two hits, both in the same file: declaration + the single internal use. Zero external callers. Safe to rename + delete the back-compat alias. Per `feedback_no_deprecated_alias_on_clarifying_rename`: full rename + no alias; aliases re-surface misuse.

**Alignment with PLAN §2.3 line 69** ("read R9_REPLYER_LITE_ENV from src/config/reply-planner.ts"): preserved in spirit. The harness still imports from `src/config/reply-planner.ts`; the env name is still owned by exactly one module. The shape is now a function instead of a const, matching `isReplyerLiteEnabled(groupConfig)` next door.

**Alignment with PLAN §2.2** ("No edits to chat.ts other than optional getter"): preserved. Edit is in `src/config/reply-planner.ts`, not chat.ts.

---

## 2. Wire diff shape (for Architect)

### 2.1 `scripts/eval/replay-runner-core.ts` — `constructChatModule` (lines 58-75)

```ts
// imports added at top of file
import { isReplyerLiteEnvOn } from '../../src/config/reply-planner.js';
import { ReplyPlanner } from '../../src/modules/reply-planner.js';
import type { IReplyPlanner } from '../../src/modules/reply-planner.js';
import { createLogger } from '../../src/utils/logger.js';

// constructChatModule shape change
export function constructChatModule(args: {
  tmpDbPath: string;
  botQQ: string;
  mockClaude: IClaudeClient;
}): { chat: ChatModule; db: Database; replyPlanner: IReplyPlanner | null } {
  if (!args.tmpDbPath.includes('.tmp') && !args.tmpDbPath.includes('synthetic')) {
    throw new Error(
      `constructChatModule refuses to open a DB path that does not look tmp/synthetic: ${args.tmpDbPath}`,
    );
  }
  const db = new Database(args.tmpDbPath);
  const chat = new ChatModule(args.mockClaude, db, {
    botUserId: args.botQQ,
    moodProactiveEnabled: false,
    deflectCacheEnabled: false,
  });

  // R9: wire ReplyPlanner mirroring src/index.ts:629-637 production wiring,
  // gated on the harness-readable env flag. Default-null arm preserves
  // byte-identical pre-R9 harness behavior when the flag is unset.
  // Reuses args.mockClaude as the IClaudeClient (one LLM client per run);
  // RealClaudeClientForReplay in real mode already encapsulates the Gemini
  // routing + cost cap + retry. fail-open on import/construct errors per
  // src/index.ts:634-636 precedent.
  let replyPlanner: IReplyPlanner | null = null;
  if (isReplyerLiteEnvOn()) {
    try {
      replyPlanner = new ReplyPlanner(args.mockClaude, createLogger('reply-planner-replay'));
      chat.setReplyPlanner(replyPlanner);
    } catch (err) {
      createLogger('replay-runner-core').warn(
        { err: String(err) },
        'R9 reply-planner not wired in harness — continuing without',
      );
      replyPlanner = null;
    }
  }

  return { chat, db, replyPlanner };
}
```

LOC delta: +18 to +22 inside `constructChatModule`, +4 imports. Total file delta well under PLAN §3 budget (≤ +30; current file ~330 LoC, 400 cap).

**Helpers normalize input internally** (`feedback_normalize_inside_helper`): `isReplyerLiteEnvOn()` reads env directly, no caller-passes-flag plumbing. Validator `feedback_validator_at_every_boundary`: `chat.setReplyPlanner` already accepts `IReplyPlanner | null`; we hand it a constructed instance OR never call it (default-null path). No bypass.

### 2.2 `scripts/eval/replay-runner.ts:298-302` — caller update

Existing:

```ts
const { chat, db } = constructChatModule({
  tmpDbPath: tmpDb,
  botQQ: args.botQQ,
  mockClaude: llmClient,
});
```

No edit needed. The third returned field `replyPlanner` is ignored by destructuring (TypeScript-safe).

### 2.3 `scripts/eval/replay-types.ts` — `ReplayRow` shape (lines 28-66)

Insert one field, between `violationTags` and `errorMessage` (the "diagnostics" group):

```ts
// diagnostics
violationTags: string[];
plannerSource: 'llm-planner' | 'rule-fallback' | 'no-planner-skipped' | null;
errorMessage: string | null;
durationMs: number;
```

LOC delta: +1.

### 2.4 `scripts/eval/replay-runner-core.ts` — `buildReplayRow` projection

Project `result.meta.plannerSource` for every non-error kind. For `error` kind, use `null`. Add to `BuildReplayRowArgs` is not necessary because `result` is already in scope; we read `result.meta.plannerSource` directly inside `buildReplayRow`.

Five branches in `buildReplayRow` (one per ReplayResultKind: error, reply, sticker, fallback, silent/defer) each get one new field. Pattern:

```ts
// error branch (lines 120-138)
plannerSource: null,

// reply branch (lines 140-158)
plannerSource: result.meta.plannerSource ?? null,

// sticker branch (lines 160-178)
plannerSource: result.meta.plannerSource ?? null,

// fallback branch (lines 180-198)
plannerSource: result.meta.plannerSource ?? null,

// silent | defer branch (lines 200-217)
plannerSource: result.meta.plannerSource ?? null,
```

LOC delta: +5 (one per branch).

The `?? null` defensive read covers the case where a non-error ChatResult somehow lacks `plannerSource` on its meta — `BaseResultMeta.plannerSource` is `?`-optional per `src/utils/chat-result.ts:32`, so `result.meta.plannerSource` may be `undefined` on a ChatResult constructed by code paths that bypass `metaBuilder.setDirective`. Coercing to `null` keeps the JSONL stable (no `undefined` written; `replay-runner-mock.test.ts:66` already asserts `JSON.stringify(parsed)).not.toContain('undefined')`).

**Field-order placement note for Architect**: the field goes immediately after `violationTags`. Any other position changes the JSON.stringify byte order and would diff every line of every existing benchmark snapshot. Tests for stable JSON ordering (DEV-READY §2.1 single-source-of-truth assertion) anchor on the existing key order; new field tail-appended within the diagnostics group is the safe spot.

---

## 3. Mock LLM client shape (for tests T-3, T-3c)

### 3.1 Why we cannot mock at `IReplyPlanner.plan` boundary in smoke tests

Existing `chat-planner-integration.test.ts` mocks `IReplyPlanner` directly (`makePlannerStub` returns `{ plan: vi.fn() }`). That works for unit tests of chat.ts because the test calls `chat.setReplyPlanner(stub)` itself.

In the harness path, `runReplay` (smoke integration) calls `constructChatModule` internally, which constructs a REAL `ReplyPlanner` instance bound to whatever `IClaudeClient` was passed. We cannot intercept that. We MUST drive behavior at the `IClaudeClient.complete` boundary.

`MockClaudeClient` (`scripts/eval/mock-llm.ts`) currently returns `[mock:${hex8}] 好的` for ALL calls. When the Planner's `tolerantParseDirective` sees this string, it returns `null` → chat.ts:3231 falls into rule-fallback. So the **default mock-LLM behavior gives `plannerSource = 'rule-fallback'` automatically** — perfect for T-3 happy-path-style coverage, but NOT for T-3 ("planner success" assertion) which wants `'llm-planner'`.

### 3.2 Two clean options for T-3 "planner success"

**Option α (recommended)**: Subclass `MockClaudeClient` inside the test file with a system-prompt-discriminating `complete()`. The Planner system prompt starts with `你是一个回复计划器` (`src/modules/reply-planner.ts:462`); a chat call's system prompt does not.

```ts
class PlannerAwareMockClaude extends MockClaudeClient {
  async complete(req: ClaudeRequest): Promise<ClaudeResponse> {
    const sysText = req.system.map(b => b.text).join('\n');
    if (sysText.startsWith('你是一个回复计划器')) {
      return {
        text: JSON.stringify({
          mode: 'reply',
          length_budget: 'short',
          required_fact_ids: [],
          forbidden_tokens: [],
          tone_hint: '群友语气',
          use_sticker_token: null,
        }),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
    }
    return super.complete(req);
  }
}
```

Justification:
- Reuses MockClaudeClient's deterministic chat-call behavior (same `sha1` route) for all non-Planner calls. Smoke test still gets the existing `[mock:hex8] 好的` reply text, so `replay-output.jsonl` stays comparable to existing mock-mode runs except for the new `plannerSource` field.
- System-prompt sentinel is stable (production prompt; already canonical) and test owner can tighten the match if the prompt wording shifts.
- Output JSON satisfies `tolerantParseDirective` (no markdown fences, no prefix) AND `validateDirective` against the safe context (`mode: 'reply'`, `length_budget: 'short'`, `required_fact_ids: []` — no fact-id consistency check needed since hasDirectTrigger is true and no fact pre-condition is invoked).
- Lives in the test file — zero source code change for the mock pattern; test is the boundary.

**Option β (rejected)**: Add a `preset` mode to `MockClaudeClient` itself. Rejected because it muddies a deterministic stub used by every other replay-runner test.

**Decision**: **Option α**. Test file `replay-runner-r9-smoke.test.ts` (or extension to `replay-runner-mock.test.ts` per Architect's call) defines `PlannerAwareMockClaude` inline.

### 3.3 Throwing variant for T-3c

```ts
class ThrowingPlannerMockClaude extends MockClaudeClient {
  async complete(req: ClaudeRequest): Promise<ClaudeResponse> {
    const sysText = req.system.map(b => b.text).join('\n');
    if (sysText.startsWith('你是一个回复计划器')) {
      throw new Error('planner-mock simulated timeout');
    }
    return super.complete(req);
  }
}
```

The `ReplyPlanner.plan` catches the throw at `reply-planner.ts:643-648` and returns `null`. chat.ts:3220-3222 catch path is NOT reached because Planner already absorbed; instead `validated = validateDirective(null, ...)` → falls into chat.ts:3231-3242 rule-fallback branch. `plannerSource = 'rule-fallback'`, `fellBackReason = 'parse'` (because `planned === null`). T-3c asserts `plannerSource === 'rule-fallback'`.

Note for Architect/Developer: chat.ts maps a Planner-returned-null to `fellBackReason='parse'`, not `'timeout'`. The PLAN T-3c label "timeout sim" was loose phrasing; the actual surfaced fellBackReason is `'parse'` because Planner internally caught the throw and returned null. Test assertion should be on `plannerSource === 'rule-fallback'`, NOT on `fellBackReason === 'timeout'`. (chat.ts:3221 sets `fellBackReason='timeout'` only if the throw escapes Planner — which our Planner instance never lets happen.)

### 3.4 Strict no-throw fail-open invariant

Both mock variants live INSIDE the test file, not in `scripts/eval/mock-llm.ts`. Default `MockClaudeClient` stays unchanged so every existing replay-runner-mock test keeps its current (fault-isolated) behavior.

---

## 4. Replay row fixture for smoke test (T-3 / T-3b / T-3c)

### 4.1 Choice: synthetic `9002` row, NOT gold-1027

PLAN §6.4 mentioned "1 specific row from gold-1027 that triggers Planner path". Designer revises: the existing synthetic fixture row `9002` ALREADY satisfies Planner-path entry conditions and does not require live prod-DB copy.

`test/fixtures/replay-benchmark-synthetic.jsonl` row 2:

```json
{
  "id": "958751334:9002",
  "groupId": "958751334",
  "messageId": 9002,
  "userId": "U1002",
  "nickname": "李四",
  "content": "有人在吗",
  "rawContent": "有人在吗",
  "category": 1,
  "categoryLabel": "direct_at_bot",
  "label": {
    "expectedAct": "direct_chat",
    "expectedDecision": "reply",
    "isDirect": true
  }
}
```

`isDirect: true` triggers chat.ts:3160 `r9SkipForScope = false`. `userId: 'U1002' ≠ 'bot-r9'` triggers `r9SkipForBotSelf = false`. With `R9_REPLYER_LITE_ENABLED='1'` the env-driven path makes `r9Enabled = true`. With our wire, `this.replyPlanner !== null` becomes true. → `r9ShouldRunPlanner = true` → Planner runs. Confirmed Planner-path entry without touching prod-DB or gold-1027.

### 4.2 Why gold-1027 is unnecessary AND avoided

- Reviewer's smoke (PLAN §6.4) runs against gold-1027 with real-LLM Gemini, $0.50 cap, 5-row limit. That's the live-fire validation, not unit/smoke-test territory.
- Synthetic fixture is committed (`build-synthetic-replay-db.ts:42-65`) and regenerates idempotently per `replay-runner-mock.test.ts:43`. No prod-DB contamination risk.
- Per `feedback_worktree_fixture_file_absence`: fresh worktrees lack gitignored fixtures. The synthetic `.sqlite` fixture path is committed; gold-1027 may not be in the worktree's filesystem at all. Using synthetic keeps tests portable.

### 4.3 Per-group config for T-3 / T-3c

For the synthetic row, group `958751334` has NO `chatPlannerLiteV1` row in the DB (build-synthetic only inserts messages). So `isReplyerLiteEnabled(groupConfig)` falls through to `isReplyerLiteEnvOn()`. Tests that set `process.env['R9_REPLYER_LITE_ENABLED']='1'` in `beforeEach` (BEFORE calling `runReplay`) get the lazy-read function reading the live env value at chat.ts:3157 invocation time. Works deterministically.

T-3b: env unset (delete `process.env['R9_REPLYER_LITE_ENABLED']` or set to `''`) → `isReplyerLiteEnvOn()` returns false → `r9Enabled = false` → `r9ShouldRunPlanner = false` → chat.ts:3247-3259 skip branch → `plannerSource = 'no-planner-skipped'`, `fellBackReason = 'flag-off'`.

---

## 5. Test matrix v2 (final — locked for Architect)

All test files use `vi.unstubAllEnvs?.()` + explicit `delete process.env['R9_REPLYER_LITE_ENABLED']` in `afterEach` to prevent cross-file pollution. PLAN §7 risk row 3 mitigation.

**File 1**: `test/scripts/eval/replay-harness-r9-wire.test.ts` (new) — harness-unit tests.
**File 2**: `test/eval/replay-runner-r9-smoke.test.ts` (new) — smoke-integration tests.

Architect may merge File 2 into the existing `test/eval/replay-runner-mock.test.ts`. Designer mild preference: separate file. Rationale: keeps the `JSON.stringify(parsed)).not.toContain('undefined')` invariant in `replay-runner-mock.test.ts` decoupled from the new R9-specific assertions; if a future change causes the new field to leak `undefined` somewhere, the existing test catches it AND the R9 file catches it independently.

### 5.1 Mandatory tests (6 — all required for APPROVED gate)

| ID | Level | File | Setup | Mock LLM behavior | Assertion |
|---|---|---|---|---|---|
| **T-1** | harness-unit | replay-harness-r9-wire.test.ts | `process.env['R9_REPLYER_LITE_ENABLED'] = '1'`; instantiate a vanilla `MockClaudeClient`; call `constructChatModule({ tmpDbPath: <tmp>, botQQ: 'bot-test', mockClaude })` | n/a (no run) | Returned tuple has `replyPlanner !== null`; `replyPlanner` is an instance of `ReplyPlanner` (use `instanceof` import). `chat.replyPlanner` private state matches via end-to-end smoke (see T-3); not asserted directly. |
| **T-2** | harness-unit | replay-harness-r9-wire.test.ts | `delete process.env['R9_REPLYER_LITE_ENABLED']`; call `constructChatModule(...)` | n/a | `replyPlanner === null` returned. Default-null arm preserves byte-identical opt-in semantics. |
| **T-2b (edge)** | harness-unit | replay-harness-r9-wire.test.ts | `process.env['R9_REPLYER_LITE_ENABLED'] = ''` (empty string, not unset) | n/a | `replyPlanner === null`. Confirms env match is strict `=== '1'` not truthy-coerce. Mirrors `isReplyerLiteEnvOn` invariant. |
| **T-3 (success)** | smoke-integration | replay-runner-r9-smoke.test.ts | `process.env['R9_REPLYER_LITE_ENABLED']='1'`; `runReplay(makeArgs(outDir))` against synthetic fixture; mockClaude is `PlannerAwareMockClaude` (§3.2 above) | Planner system → canned valid Directive JSON; chat call → default `[mock:...]` text | At least 1 row in `replay-output.jsonl` has `plannerSource === 'llm-planner'`. The `9002` direct-at-bot row should hit this. |
| **T-3b (edge — flag off)** | smoke-integration | replay-runner-r9-smoke.test.ts | env UNSET; same `runReplay` invocation; mockClaude is vanilla `MockClaudeClient` | Default `[mock:...] 好的` for all calls | Every row has `plannerSource === 'no-planner-skipped'`. Regression alarm: a future change leaking the wire would flip at least one row off this value. |
| **T-3c (edge — planner-throw fallback)** | smoke-integration | replay-runner-r9-smoke.test.ts | `process.env['R9_REPLYER_LITE_ENABLED']='1'`; `runReplay`; mockClaude is `ThrowingPlannerMockClaude` (§3.3 above) | Planner system → `throw new Error(...)`; chat call → default text | At least 1 row has `plannerSource === 'rule-fallback'` (NOT `'no-planner-skipped'` and NOT `'llm-planner'`). Proves Planner WAS reached AND the rule-fallback branch fires. |

### 5.2 Optional tests (Designer/Architect may add — non-blocking)

| ID | Level | Setup | Assertion | Value |
|---|---|---|---|---|
| **T-4** | smoke-integration | env on + scope='direct-only' (default); trigger row with `isDirect: false` (use synthetic row 9001) | `plannerSource === 'no-planner-skipped'` | Proves chat.ts `r9SkipForScope` still gates even with planner wired. |
| **T-5** | smoke-integration | env on + trigger from bot-self (synthesize a row with `userId === botQQ`) | `plannerSource === 'no-planner-skipped'` | Proves chat.ts `r9SkipForBotSelf` still gates. |

T-4 / T-5 are nice-to-have. Architect's call. Mandatory bar = 6.

### 5.3 Env-restore discipline (mandatory in every test)

```ts
const ENV_KEY = 'R9_REPLYER_LITE_ENABLED';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});
```

This pattern (snapshot + restore) is the single source of truth for env hygiene. `vi.stubEnv` is NOT used — it doesn't help with the lazy-read function any more than a direct `process.env` set, and it adds a vitest-version coupling not needed here.

---

## 6. Reviewer real-LLM smoke (task #36) — operating notes

Reviewer runs (per PLAN §6.4 + acceptance criteria):

```bash
export R9_REPLYER_LITE_ENABLED=1
export CHAT_MODEL=gemini-2.5-flash
export GEMINI_API_KEY="$(cat ~/.secrets/gemini-key)"   # or however the reviewer keeps it
npx tsx scripts/eval/replay-runner.ts \
  --gold-path test/fixtures/replay-gold-synthetic.jsonl \
  --benchmark-path test/fixtures/replay-benchmark-synthetic.jsonl \
  --prod-db-path test/fixtures/replay-prod-db-synthetic.sqlite \
  --output-dir /tmp/r9-wire-smoke \
  --llm-mode real \
  --limit 5 \
  --max-cost-usd 0.50 \
  --bot-qq 1705075399 \
  --group-id 958751334
```

Assertion (manual, by Reviewer): inspect `/tmp/r9-wire-smoke/replay-output.jsonl`; at least one of the 5 lines has `"plannerSource":"llm-planner"` OR `"plannerSource":"rule-fallback"`. Both prove the wire works end-to-end through the real Gemini path. `"plannerSource":"no-planner-skipped"` on EVERY row would indicate the wire is broken and Reviewer must REVISE.

Cost estimate: 5 rows × (1 chat call + 1 planner call) × ~$0.005/call ≈ $0.05. Well under the $0.50 cap.

`CHAT_MODEL=gemini-2.5-flash` is set per PLAN acceptance criterion 5; the `RealClaudeClientForReplay` wrapper routes both the chat call AND the planner call through Gemini (one IClaudeClient instance, both call sites). The R9.5 review's `CHAT_MODEL` divergence concern is sidestepped here because the harness's existing client decision is the single source of truth — the Planner inherits the same client.

---

## 7. Standing rules audit (verbatim, embedded)

- **ASCII single quotes only** — `feedback_no_smart_quotes`. NO U+2018/2019/201C/201D in any file this PR touches. Architect verifies during diff review; Developer verifies via `grep -P '[\x{2018}\x{2019}\x{201C}\x{201D}]' <files>` returning zero matches before commit.
- **No emojis** — in code, comments, commit message, test names. PLAN, DESIGN, and Architect DEV-READY files all comply.
- **Edge tests mandatory** — `feedback_edge_testing_soul`. T-2b, T-3b, T-3c are non-negotiable. Reviewer rejects on missing.
- **Conventional commits** — `feat`/`fix`/`refactor`/`docs`/`test`/`chore`. Locked single commit: `fix(eval): wire R9 ReplyPlanner into replay-runner harness + regression tests`.
- **Helpers normalize input internally** — `feedback_normalize_inside_helper`. `isReplyerLiteEnvOn()` reads env directly (helper internal); `constructChatModule` reads the function (helper internal). No "caller passes flag" pattern.
- **Validator at every boundary** — `feedback_validator_at_every_boundary`. `chat.setReplyPlanner(p: IReplyPlanner | null)` is the validator. We hand it a constructed instance OR don't call it. No bypass cast.
- **Bot is groupmate not assistant** — `feedback_groupmate_not_assistant_lens`. N/A this PR (no bot-output behavior change).
- **Trusted rules outside untrusted data** — `feedback_trusted_rules_outside_untrusted_data_inside`. N/A this PR (no LLM prompt edit; mock prompts are test-internal canned strings).
- **Metadata on result not side-channel** — `feedback_metadata_on_result_not_side_channel`. Strategy 1 (ReplayRow.plannerSource field, projected from result.meta) chosen; Strategy 2 (DB-side query) explicitly rejected on this rule.
- **No deprecated alias on clarifying rename** — `feedback_no_deprecated_alias_on_clarifying_rename`. `R9_REPLYER_LITE_ENV` const fully deleted in favor of `isReplyerLiteEnvOn()` function; no back-compat alias.
- **Reviewer does NOT merge to default branch** — `feedback_never_autonomous_merge_to_default_branch`. APPROVED verdict + open PR + wait for user gate. Reviewer briefing reaffirms this.
- **No `.claude/` paths in commit diff** — verified: only `docs/specs/replay-harness-fix-DESIGN.md` (this file) and the source/test files in `src/`, `scripts/`, `test/` are touched. `.claude/worktrees/` is a worktree mount; commits land on the branch in the main repo via `git -C` discipline.
- **No `Co-Authored-By` trailer** — single-line conventional commit message.

---

## 8. Iteration Contract — Designer DONE state

Per `feedback_iteration_contract_needs_explicit_ack`:

- This DESIGN is saved at `D:/QQ-Group-Bot/.claude/worktrees/replay-harness-fix/docs/specs/replay-harness-fix-DESIGN.md`.
- Task #33 marked `completed` via TaskUpdate immediately after save.
- SendMessage to team-lead: `"Harness Fix DESIGN DONE: Q1 reuse mockClaude / Q2 Option C return planner / Q3 Strategy 1 plannerSource on ReplayRow / env timing resolved via lazy isReplyerLiteEnvOn() with R9_REPLYER_LITE_ENV const deleted"`.
- Architect (#34) starts only after team-lead "approved".

---

## 9. Architect (task #34) — handover anchors

Architect produces verbatim diff. Every change anchors to a section above:

- §1.5 — `src/config/reply-planner.ts` rename (const → function, +3 LOC net after delete)
- §2.1 — `scripts/eval/replay-runner-core.ts` `constructChatModule` (+18 to +22 LOC, +4 imports)
- §2.3 — `scripts/eval/replay-types.ts` ReplayRow (+1 LOC)
- §2.4 — `scripts/eval/replay-runner-core.ts` buildReplayRow (+5 LOC, one per branch)
- §3.2, §3.3 — test-file inline mock subclasses (~15 LOC each, in test file only)
- §5 — test files (`test/scripts/eval/replay-harness-r9-wire.test.ts` + `test/eval/replay-runner-r9-smoke.test.ts`); est ~60 + ~80 LOC = ~140 LOC

Total est: 25 + 1 + 5 + 30 (mocks) + 140 (tests) ≈ 200 LOC across 5 files. Comfortable within PLAN §3 budget.

Files touched count: 5 (one config, two harness, two test). Single commit. Push to `origin/fix/replay-runner-r9-planner-wire`. Open PR with `--base main --head fix/replay-runner-r9-planner-wire` per `feedback_gh_pr_create_explicit_base_head`.
