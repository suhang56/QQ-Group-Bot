# Replay-Runner Harness Fix — DEV-READY

**Phase**: Architect (task #34)
**Branch**: `fix/replay-runner-r9-planner-wire`
**Worktree**: `D:/QQ-Group-Bot/.claude/worktrees/replay-harness-fix/`
**Master parent**: `6449849`
**Inputs (LOCKED)**: `replay-harness-fix-PLAN.md`, `replay-harness-fix-DESIGN.md`.

This document is a verbatim diff plan for the Developer (task #35). Every change anchors to a Designer §-section. Line pins were re-verified against current HEAD `6449849` on 2026-05-05; no drift detected. Single commit on `fix/replay-runner-r9-planner-wire`.

---

## 0. Line-pin verification (HEAD `6449849`)

| File | Pin claim | Actual | Status |
|---|---|---|---|
| `src/config/reply-planner.ts` lines 13-14 | `R9_REPLYER_LITE_ENV = process.env['R9_REPLYER_LITE_ENABLED'] === '1'` | matches verbatim | OK |
| `src/config/reply-planner.ts` line 20 | internal use `return R9_REPLYER_LITE_ENV;` | matches verbatim | OK |
| `scripts/eval/replay-runner-core.ts` lines 58-75 | `constructChatModule(...)` body, returns `{ chat, db }` (no planner) | matches | OK |
| `scripts/eval/replay-runner.ts` line 298 | sole external caller; destructures `{ chat, db }` | matches | OK |
| `scripts/eval/replay-runner-core.ts` line 98 | `buildReplayRow` is single source of truth for ReplayRow shape; 5 result-kind branches | matches | OK |
| `scripts/eval/replay-types.ts` lines 28-66 | `ReplayRow` interface, fields ordered `... violationTags / errorMessage / durationMs / llmInputTokens ...` | matches; insertion point is between `violationTags` and `errorMessage` (lines 57 → 58) | OK |
| `src/index.ts` lines 629-637 | production wire — try/catch, `new ReplyPlanner(replyPlannerLLM, createLogger('reply-planner'))`, `chat.setReplyPlanner(...)` | matches | OK |
| `src/modules/chat.ts` line 1664 | `private replyPlanner: IReplyPlanner | null = null;` | matches | OK |
| `src/modules/chat.ts` line 1665 | `setReplyPlanner(p: IReplyPlanner | null): void` validator | matches | OK |
| `src/modules/chat.ts` line 3157 | `r9Enabled = isReplyerLiteEnabled(groupConfigForFlag)` (lazy call) | matches | OK |
| `src/modules/chat.ts` line 3164 | `&& this.replyPlanner !== null` is the 4th conjunct | matches | OK |
| `src/modules/chat.ts` line 3177 | `let plannerSource: ... = 'no-planner-skipped';` | matches | OK |
| `src/modules/chat.ts` line 3220-3225 | `try { planned = await this.replyPlanner!.plan(...) } catch (err) { fellBackReason = 'timeout'; } finally { clearTimeout(...) }` | matches; planner internally absorbs throw → returns null → `planned === null` → 3241 sets `fellBackReason = 'parse'`, NOT 'timeout' | OK |
| `src/modules/chat.ts` line 3230 | `plannerSource = 'llm-planner';` (validated branch) | matches | OK |
| `src/modules/chat.ts` line 3240 | `plannerSource = 'rule-fallback';` (fallback branch) | matches | OK |
| `src/modules/reply-planner.ts` line 128-130 | `IReplyPlanner.plan(ctx, signal): Promise<Directive | null>` | matches | OK |
| `src/modules/reply-planner.ts` line 462 | `const R9_PLANNER_SYSTEM_PROMPT = ['你是一个回复计划器。...', ...]` (joins with `\n`) | matches; system prompt's first line starts `'你是一个回复计划器'` | OK |
| `src/modules/reply-planner.ts` line 593-602 | `constructor(llm: IClaudeClient, logger: Logger, opts?: ReplyPlannerOptions)` | matches | OK |
| `src/modules/reply-planner.ts` line 643-648 | catch block in `plan()` absorbs throw, returns `null` | matches | OK |
| `src/utils/chat-result.ts` line 32 | `plannerSource?: 'llm-planner' | 'rule-fallback' | 'no-planner-skipped';` on `BaseResultMeta` | matches | OK |
| `src/utils/logger.ts` line 12 | `export function createLogger(name: string): Logger` | matches | OK |
| `src/ai/claude.ts` lines 32-58 | `ClaudeRequest`, `ClaudeResponse`, `IClaudeClient` shape | matches; `ClaudeRequest.system: CachedSystemBlock[]` (each block has `.text: string`) | OK |
| `scripts/eval/mock-llm.ts` lines 27-67 | `MockClaudeClient` class shape: `complete(req)`, deterministic `[mock:hex8] 好的`, hex8 = sha1(systemText + '\n' + messagesText).slice(0,8); also `describeImage` and `visionWithPrompt` | matches; subclasses CAN call `super.complete(req)` to inherit deterministic behavior | OK |
| `test/fixtures/replay-benchmark-synthetic.jsonl` row 2 (id `958751334:9002`) | `isDirect: true`, `category: 1`, `categoryLabel: 'direct_at_bot'`, `userId: 'U1002'` (not bot) | matches verbatim | OK |
| `test/eval/replay-runner-mock.test.ts` lines 11-37 | reusable `makeArgs(outDir, overrides?)`, `tmpDir(prefix)`, paths to gold/benchmark/fixture-DB | matches; new test file uses same idiom | OK |
| `test/scripts/eval/` | exists; sibling files `real-llm-config.test.ts`, `replay-runner-real-mode.test.ts` | exists | OK |

No drift. Architect proceeds with Designer's locked diff shape unchanged.

---

## 1. Files touched (single commit)

| File | Change | LOC delta (net) | Anchor |
|---|---|---|---|
| `src/config/reply-planner.ts` | delete `R9_REPLYER_LITE_ENV` const, add `isReplyerLiteEnvOn()` lazy fn, switch internal caller | +5 / -3 = +2 | DESIGN §1.5 |
| `scripts/eval/replay-runner-core.ts` | imports + `constructChatModule` planner wire + return-shape change + `buildReplayRow` projection (5 branches) | ~+30 / -1 = +29 | DESIGN §2.1, §2.4 |
| `scripts/eval/replay-types.ts` | add `plannerSource` field to `ReplayRow` | +1 | DESIGN §2.3 |
| `test/scripts/eval/replay-harness-r9-wire.test.ts` | NEW — T-1, T-2, T-2b | ~+85 | DESIGN §5.1 |
| `test/eval/replay-runner-r9-smoke.test.ts` | NEW — T-3, T-3b, T-3c | ~+150 | DESIGN §5.1 |
| `docs/specs/replay-harness-fix-DEV-READY.md` | this file (already saved) | n/a | n/a |

Total code: ~270 LOC (Designer's ~200 LOC estimate plus inline mock subclasses + env-restore boilerplate). Inside file budget: `replay-runner-core.ts` 330 + 29 = 359 LoC, well under the 400 LoC cap.

`scripts/eval/replay-runner.ts:298-302` caller — **NOT EDITED**. `const { chat, db } = constructChatModule(...)` continues to work; the new third returned field `replyPlanner` is silently ignored by destructuring. (TypeScript-safe — DESIGN §2.2.)

`src/modules/chat.ts` — **NOT EDITED**. Option C avoids the public-getter expansion (PLAN §2.2 LOCKED).

---

## 2. Verbatim diffs

### 2.1 `src/config/reply-planner.ts` (DESIGN §1.5)

**Current** (file is 28 lines total; only the 3 declarations matter):

```ts
import type { GroupConfig } from '../storage/db.js';

/**
 * R9: feature flag for reply-planner-lite v1 (MUCA constraint layer).
 * Default OFF everywhere. Canary group `958751334` per R9 rollout playbook;
 * scope default 'direct-only' until canary stabilizes.
 *
 * Three precedence levels (highest first):
 * 1. per-group GroupConfig.chatPlannerLiteV1 = true
 * 2. process.env.R9_REPLYER_LITE_ENABLED = '1' (test/dev override)
 * 3. compile-time default = false
 */
export const R9_REPLYER_LITE_ENV =
  process.env['R9_REPLYER_LITE_ENABLED'] === '1';

export function isReplyerLiteEnabled(
  groupConfig: GroupConfig | null | undefined,
): boolean {
  if (groupConfig?.chatPlannerLiteV1 === true) return true;
  return R9_REPLYER_LITE_ENV;
}

export function replyerLiteScope(
  groupConfig: GroupConfig | null | undefined,
): 'direct-only' | 'all' {
  return groupConfig?.chatPlannerLiteScope ?? 'direct-only';
}
```

**After**:

```ts
import type { GroupConfig } from '../storage/db.js';

/**
 * R9: feature flag for reply-planner-lite v1 (MUCA constraint layer).
 * Default OFF everywhere. Canary group `958751334` per R9 rollout playbook;
 * scope default 'direct-only' until canary stabilizes.
 *
 * Three precedence levels (highest first):
 * 1. per-group GroupConfig.chatPlannerLiteV1 = true
 * 2. process.env.R9_REPLYER_LITE_ENABLED = '1' (test/dev override; read lazily
 *    at call-time so per-test env mutations take effect — module-load capture
 *    would silently ignore beforeEach assignments)
 * 3. compile-time default = false
 */
export function isReplyerLiteEnvOn(): boolean {
  return process.env['R9_REPLYER_LITE_ENABLED'] === '1';
}

export function isReplyerLiteEnabled(
  groupConfig: GroupConfig | null | undefined,
): boolean {
  if (groupConfig?.chatPlannerLiteV1 === true) return true;
  return isReplyerLiteEnvOn();
}

export function replyerLiteScope(
  groupConfig: GroupConfig | null | undefined,
): 'direct-only' | 'all' {
  return groupConfig?.chatPlannerLiteScope ?? 'direct-only';
}
```

Net LOC: +5 (function body + brace + comment line) / -3 (const declaration + its 2-line body, plus old comment substituted) = +2 net.

**Grep validation Developer must run before commit** (mandatory; Designer §1.5 lines 105-110 confirmed zero external callers, but Developer re-verifies):

```bash
cd "D:/QQ-Group-Bot/.claude/worktrees/replay-harness-fix"
git grep -n 'R9_REPLYER_LITE_ENV\b' -- src/ scripts/ test/
```

Expected output: empty (zero matches). Any non-empty result = an external caller was missed; Developer halts and SendMessage team-lead before commit.

`feedback_no_deprecated_alias_on_clarifying_rename`: full delete, no `export const R9_REPLYER_LITE_ENV = isReplyerLiteEnvOn()` back-compat alias. Aliases re-surface misuse.

### 2.2 `scripts/eval/replay-runner-core.ts` — imports (DESIGN §2.1)

**Add after line 23** (after the existing `RealClaudeClientForReplay` import) — block of 4 imports keeps the relative-path style consistent with existing imports in this file:

```ts
import { isReplyerLiteEnvOn } from '../../src/config/reply-planner.js';
import { ReplyPlanner } from '../../src/modules/reply-planner.js';
import type { IReplyPlanner } from '../../src/modules/reply-planner.js';
import { createLogger } from '../../src/utils/logger.js';
```

LOC delta: +4.

**Note**: imports are ASCII only; no smart quotes, no emojis. `feedback_no_smart_quotes`.

### 2.3 `scripts/eval/replay-runner-core.ts` — `constructChatModule` (DESIGN §2.1)

**Replace lines 58-75 (the entire function body) with**:

```ts
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
  // gated on the harness-readable env flag (lazy read so per-test
  // beforeEach assignments take effect). Default-null arm preserves
  // byte-identical pre-R9 harness behavior when the flag is unset.
  // Reuses args.mockClaude as the IClaudeClient (one LLM client per run);
  // RealClaudeClientForReplay in real mode already encapsulates Gemini
  // routing + cost cap + retry. Fail-open on construct errors per
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

LOC delta: previous body (lines 58-75) was 18 lines; new body is ~38 lines. Net +20.

**Validator preserved at boundary** (`feedback_validator_at_every_boundary`): `chat.setReplyPlanner(p: IReplyPlanner | null)` at chat.ts:1665 is the validator; we hand it a constructed `ReplyPlanner` instance OR never call it (default-null path). No bypass cast.

**Helpers normalize input internally** (`feedback_normalize_inside_helper`): `isReplyerLiteEnvOn()` reads env directly. Caller does NOT pass a flag.

**Logger naming**: `'reply-planner-replay'` distinguishes harness-emitted planner logs from production-bot's planner logs in mixed log streams (DESIGN §1.4).

### 2.4 `scripts/eval/replay-runner-core.ts` — `buildReplayRow` projection (DESIGN §2.4)

`result` is in scope from line 100 (destructured at top of function). For each of the 5 result-kind branches, add `plannerSource` immediately after `violationTags` and before `errorMessage` — matching the field-order placement in the `ReplayRow` interface (DESIGN §2.3, §2.4 final paragraph: any other position changes JSON.stringify byte order).

**Branch 1 — error (lines 120-138)**: error rows have NO `result.meta` (the union is `{ kind: 'error'; errorMessage: string }`). Use literal `null`.

```ts
  if (result.kind === 'error') {
    return {
      ...base,
      resultKind: 'error',
      reasonCode: null,
      utteranceAct: 'none',
      guardPath: null,
      targetMsgId: triggerMessageId,
      usedFactHint: null,
      matchedFactIds: null,
      injectedFactIds: null,
      replyText: null,
      promptVariant: null,
      violationTags: [...violationTags],
      plannerSource: null,
      errorMessage: result.errorMessage,
      durationMs,
      ...usage,
    };
  }
```

**Branch 2 — reply (lines 140-158)**:

```ts
      violationTags: [...violationTags],
      plannerSource: result.meta.plannerSource ?? null,
      errorMessage: null,
```

**Branch 3 — sticker (lines 160-178)**:

```ts
      violationTags: [...violationTags],
      plannerSource: result.meta.plannerSource ?? null,
      errorMessage: null,
```

**Branch 4 — fallback (lines 180-198)**:

```ts
      violationTags: [...violationTags],
      plannerSource: result.meta.plannerSource ?? null,
      errorMessage: null,
```

**Branch 5 — silent | defer (lines 200-217)**:

```ts
      violationTags: [...violationTags],
      plannerSource: result.meta.plannerSource ?? null,
      errorMessage: null,
```

LOC delta: +5 (one line per branch; 4 branches with `result.meta.plannerSource ?? null`, 1 branch with `null`).

**Why `?? null`**: `BaseResultMeta.plannerSource` is `?`-optional (`src/utils/chat-result.ts:32`). When chat.ts:3275 calls `metaBuilder.setDirective(directive, plannerSource, plannerLatencyMs)` it sets the field on the meta; but a hypothetical future ChatResult that bypasses `setDirective` could leave it `undefined`. Coercing to `null` keeps the JSONL stable: `replay-runner-mock.test.ts:66` asserts `JSON.stringify(parsed)).not.toContain('undefined')`. New field MUST not break that invariant.

### 2.5 `scripts/eval/replay-types.ts` — `ReplayRow` shape (DESIGN §2.3)

**Insert one line in the `// diagnostics` group, between `violationTags` (line 57) and `errorMessage` (line 58)**:

```ts
  // diagnostics
  violationTags: string[];
  plannerSource: 'llm-planner' | 'rule-fallback' | 'no-planner-skipped' | null;
  errorMessage: string | null;
  durationMs: number;
```

LOC delta: +1.

**Inline doc comment** (Developer adds; this gives future readers the null-semantics warning DESIGN §1.3 spelled out, in the type file rather than only in the spec):

```ts
  // diagnostics
  violationTags: string[];
  /**
   * R9 directive layer signal. `null` ONLY on error rows (no ChatResult.meta).
   * `'no-planner-skipped'` literal: env flag OFF, bot-self trigger, or
   * scope-skipped. `'llm-planner'`: Planner returned a validated Directive.
   * `'rule-fallback'`: Planner ran but returned null/invalid → rule fallback.
   */
  plannerSource: 'llm-planner' | 'rule-fallback' | 'no-planner-skipped' | null;
  errorMessage: string | null;
```

LOC delta with comment: +7 (1 field + 6 doc-comment lines). Acceptable.

---

## 3. Test files

Both test files use the snapshot-restore env-discipline idiom (DESIGN §5.3) and ASCII single quotes only. Test names contain NO emojis (`feedback_no_emojis`).

### 3.1 `test/scripts/eval/replay-harness-r9-wire.test.ts` (NEW; T-1, T-2, T-2b)

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { constructChatModule } from '../../../scripts/eval/replay-runner-core.js';
import { MockClaudeClient } from '../../../scripts/eval/mock-llm.js';
import { ReplyPlanner } from '../../../src/modules/reply-planner.js';
import { buildSyntheticReplayDb } from '../../../scripts/eval/build-synthetic-replay-db.js';

const ENV_KEY = 'R9_REPLYER_LITE_ENABLED';
const REPO = path.resolve(__dirname, '../../..');
const FIXTURE_DB_SRC = path.join(REPO, 'test/fixtures/replay-prod-db-synthetic.sqlite');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `r9-wire-${prefix}-`));
}

function makeTmpDb(prefix: string): string {
  // constructChatModule rejects DB paths without .tmp or 'synthetic'. We copy
  // the committed synthetic fixture into a tmp path that satisfies BOTH
  // tripwires: filename contains 'synthetic' AND parent dir is .tmp-ish.
  buildSyntheticReplayDb(FIXTURE_DB_SRC);
  const dir = tmpDir(prefix);
  const dst = path.join(dir, 'synthetic.db');
  fs.copyFileSync(FIXTURE_DB_SRC, dst);
  return dst;
}

describe('replay-runner harness — R9 wire (T-1 / T-2 / T-2b)', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it('T-1: R9_REPLYER_LITE_ENABLED=1 → returned replyPlanner is a ReplyPlanner instance', () => {
    process.env[ENV_KEY] = '1';
    const tmpDb = makeTmpDb('t1');
    const mockClaude = new MockClaudeClient();
    const result = constructChatModule({
      tmpDbPath: tmpDb,
      botQQ: 'bot-test',
      mockClaude,
    });
    expect(result.replyPlanner).not.toBeNull();
    expect(result.replyPlanner).toBeInstanceOf(ReplyPlanner);
    expect(result.chat).toBeDefined();
    expect(result.db).toBeDefined();
  });

  it('T-2: R9_REPLYER_LITE_ENABLED unset → returned replyPlanner is null (default-null arm)', () => {
    delete process.env[ENV_KEY];
    const tmpDb = makeTmpDb('t2');
    const mockClaude = new MockClaudeClient();
    const result = constructChatModule({
      tmpDbPath: tmpDb,
      botQQ: 'bot-test',
      mockClaude,
    });
    expect(result.replyPlanner).toBeNull();
  });

  it('T-2b (edge): R9_REPLYER_LITE_ENABLED="" → null (strict ===, not truthy-coerce)', () => {
    process.env[ENV_KEY] = '';
    const tmpDb = makeTmpDb('t2b');
    const mockClaude = new MockClaudeClient();
    const result = constructChatModule({
      tmpDbPath: tmpDb,
      botQQ: 'bot-test',
      mockClaude,
    });
    expect(result.replyPlanner).toBeNull();
  });
});
```

**Test details**:
- Uses snapshot-restore env discipline (DESIGN §5.3). NOT `vi.stubEnv` — direct mutation matches `isReplyerLiteEnvOn()`'s lazy reading semantics.
- Calls `buildSyntheticReplayDb` to regenerate fixture — same idiom as `replay-runner-mock.test.ts:43` (`feedback_worktree_fixture_file_absence`: fresh worktrees lack gitignored fixtures; regen-on-load is idempotent).
- Each test gets its OWN `tmpDir` to avoid file-handle conflicts between sibling tests.
- `instanceof ReplyPlanner` confirms the wire constructed the production class, not a stub.
- `result.chat` / `result.db` checks are smoke-only — full ChatModule behavior is covered by T-3.

LOC: ~85.

**Vitest test-name discipline**: every test name starts with `T-N:` (matches DESIGN §5.1 IDs); snake-cased descriptive remainder. No emojis.

### 3.2 `test/eval/replay-runner-r9-smoke.test.ts` (NEW; T-3, T-3b, T-3c)

```ts
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { runReplay } from '../../scripts/eval/replay-runner.js';
import type { ReplayerArgs } from '../../scripts/eval/replay-types.js';
import { buildSyntheticReplayDb } from '../../scripts/eval/build-synthetic-replay-db.js';
import { MockClaudeClient } from '../../scripts/eval/mock-llm.js';
import type { ClaudeRequest, ClaudeResponse } from '../../src/ai/claude.js';
import { snapshotProdDb, assertNoProdContamination } from './helpers.js';

const ENV_KEY = 'R9_REPLYER_LITE_ENABLED';
const REPO = path.resolve(__dirname, '../..');
const GOLD = path.join(REPO, 'test/fixtures/replay-gold-synthetic.jsonl');
const BENCH = path.join(REPO, 'test/fixtures/replay-benchmark-synthetic.jsonl');
const FIXTURE_DB = path.join(REPO, 'test/fixtures/replay-prod-db-synthetic.sqlite');

function makeArgs(outputDir: string, overrides: Partial<ReplayerArgs> = {}): ReplayerArgs {
  return {
    goldPath: GOLD,
    benchmarkPath: BENCH,
    outputDir,
    llmMode: 'mock',
    limit: null,
    prodDbPath: FIXTURE_DB,
    botQQ: '1705075399',
    groupIdForReplay: '958751334',
    perSampleTimeoutMs: 10_000,
    maxCostUsd: null,
    rateLimitRps: null,
    retryMax: null,
    maxConsecutiveErrors: null,
    ...overrides,
  };
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `r9-smoke-${prefix}-`));
}

/**
 * MockClaudeClient subclass that intercepts the Planner system-prompt call and
 * returns a canned valid Directive JSON. The Planner system prompt's first
 * line is fixed at src/modules/reply-planner.ts:463; we sentinel-match on
 * that prefix. All other calls (chat completion) fall through to the
 * deterministic [mock:hex8] default.
 */
class PlannerAwareMockClaude extends MockClaudeClient {
  override async complete(req: ClaudeRequest): Promise<ClaudeResponse> {
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

/**
 * MockClaudeClient subclass that throws on the Planner system-prompt call.
 * ReplyPlanner.plan() catches the throw at reply-planner.ts:643-648 and
 * returns null, which chat.ts:3231-3242 maps to plannerSource='rule-fallback'
 * with fellBackReason='parse' (NOT 'timeout' — the throw never escapes
 * Planner's catch). Test asserts on plannerSource only.
 */
class ThrowingPlannerMockClaude extends MockClaudeClient {
  override async complete(req: ClaudeRequest): Promise<ClaudeResponse> {
    const sysText = req.system.map(b => b.text).join('\n');
    if (sysText.startsWith('你是一个回复计划器')) {
      throw new Error('planner-mock simulated timeout');
    }
    return super.complete(req);
  }
}

/**
 * Patch runReplay's MockClaudeClient choice for one test. runReplay
 * constructs MockClaudeClient internally when llmMode='mock'; we cannot
 * pass a custom client through ReplayerArgs. Workaround: temporarily
 * mutate the prototype of MockClaudeClient.complete via vi.spyOn — but
 * subclassing approach below is cleaner via constructor injection.
 *
 * Simpler approach (chosen): for each test, directly invoke `runReplay`
 * AFTER replacing the global MockClaudeClient export via vi.mock. See
 * the per-test `vi.mock` calls below.
 *
 * Even simpler (chosen final): use the existing replay-runner-core
 * test pattern — `runReplay` builds a MockClaudeClient internally, but
 * we can mock at module boundary.
 */

describe('replay-runner harness — R9 smoke (T-3 / T-3b / T-3c)', () => {
  let savedEnv: string | undefined;
  let originalComplete: typeof MockClaudeClient.prototype.complete;

  beforeAll(() => {
    buildSyntheticReplayDb(FIXTURE_DB);
  });

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    // Snapshot the original MockClaudeClient.complete so afterEach can restore.
    originalComplete = MockClaudeClient.prototype.complete;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    // Restore prototype to pristine deterministic [mock:hex8] behavior so
    // sibling tests in other files that import MockClaudeClient see the
    // original implementation (cross-file pollution guard).
    MockClaudeClient.prototype.complete = originalComplete;
  });

  it('T-3: R9 ON + planner-aware mock → at least one row plannerSource === llm-planner', async () => {
    process.env[ENV_KEY] = '1';
    // Patch prototype so runReplay's internally-constructed MockClaudeClient
    // routes Planner system-prompt calls to the canned Directive JSON.
    MockClaudeClient.prototype.complete = PlannerAwareMockClaude.prototype.complete;

    const outDir = tmpDir('t3');
    const before = snapshotProdDb(FIXTURE_DB);
    const result = await runReplay(makeArgs(outDir));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBeGreaterThan(0);

    const lines = fs.readFileSync(path.join(outDir, 'replay-output.jsonl'), 'utf8')
      .trim().split('\n').filter(l => l.length > 0);
    const sources = lines.map(l => JSON.parse(l).plannerSource);
    expect(sources).toContain('llm-planner');

    assertNoProdContamination(FIXTURE_DB, before);
  }, 30_000);

  it('T-3b (edge): R9 OFF → every row plannerSource === no-planner-skipped (regression alarm)', async () => {
    delete process.env[ENV_KEY];
    // Vanilla MockClaudeClient.complete (no patch).
    const outDir = tmpDir('t3b');
    const result = await runReplay(makeArgs(outDir));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBeGreaterThan(0);

    const lines = fs.readFileSync(path.join(outDir, 'replay-output.jsonl'), 'utf8')
      .trim().split('\n').filter(l => l.length > 0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      // Error rows have plannerSource: null (chat path errored before R9 gate).
      // Non-error rows must be 'no-planner-skipped' when flag off.
      if (parsed.resultKind !== 'error') {
        expect(parsed.plannerSource).toBe('no-planner-skipped');
      }
    }
  }, 30_000);

  it('T-3c (edge): R9 ON + throwing-planner mock → at least one row plannerSource === rule-fallback', async () => {
    process.env[ENV_KEY] = '1';
    // Patch prototype so Planner LLM call throws; ReplyPlanner.plan catches
    // and returns null; chat.ts maps to rule-fallback with fellBackReason='parse'.
    MockClaudeClient.prototype.complete = ThrowingPlannerMockClaude.prototype.complete;

    const outDir = tmpDir('t3c');
    const result = await runReplay(makeArgs(outDir));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBeGreaterThan(0);

    const lines = fs.readFileSync(path.join(outDir, 'replay-output.jsonl'), 'utf8')
      .trim().split('\n').filter(l => l.length > 0);
    const sources = lines.map(l => JSON.parse(l).plannerSource);
    expect(sources).toContain('rule-fallback');
    // Also confirms the wire was reached: at least one row is NOT
    // 'no-planner-skipped' (would indicate the gate short-circuited
    // before Planner.plan() got called).
    expect(sources.some(s => s !== 'no-planner-skipped' && s !== null)).toBe(true);
  }, 30_000);
});
```

**Mock-injection mechanism** (Developer must understand this — Architect commits to ONE approach):

Designer §3 specified inline subclasses (`PlannerAwareMockClaude` / `ThrowingPlannerMockClaude`). However, `runReplay` in `scripts/eval/replay-runner.ts:277` constructs `new MockClaudeClient()` internally when `llmMode==='mock'`; there is NO seam to pass a custom subclass. Two options:

- **Option A (rejected)**: change `runReplay` to accept an optional `mockClaudeFactory` arg. Adds a public-API change to harness; out of scope.
- **Option B (chosen)**: mutate `MockClaudeClient.prototype.complete` at the test boundary to point at the subclass's `complete`. Restored in `afterEach`. Both subclasses still defined inline (carrying the canned-JSON / throwing logic), but only their `.prototype.complete` is borrowed via `MockClaudeClient.prototype.complete = SubClass.prototype.complete`. Methods don't bind `this` at definition; `this` will be the `MockClaudeClient` instance at call time (still works because both subclasses only call `super.complete(req)` which resolves at runtime via the patched prototype's `__proto__`, which points to `MockClaudeClient.prototype.complete` at the moment we did the swap — see "Edge case" below).

**Edge case in Option B**: `super.complete(req)` inside `PlannerAwareMockClaude.complete` resolves via `[[Prototype]]` lookup. If we install `PlannerAwareMockClaude.prototype.complete` ONTO `MockClaudeClient.prototype.complete`, the `super` chain inside that method still walks UP from `PlannerAwareMockClaude.prototype.__proto__` (which is `MockClaudeClient.prototype` — pre-patch via the `extends`). So `super.complete(req)` correctly calls the ORIGINAL `MockClaudeClient.complete` (preserved through the prototype's home object reference, NOT the dynamic value of `MockClaudeClient.prototype.complete`). This is the "home object" semantic of ES2015 `super`.

**Verification for Developer**: write the patch, run T-3 + T-3c. If `super.complete(req)` recursion-loops or misroutes, the alternative is to inline the parent's hash logic into the subclass `complete` (zero-`super`), at the cost of duplicating ~5 LoC. Developer uses inline-fallback if `super` proves brittle.

LOC: ~150.

**afterEach env-restoration discipline**: ensures other test files reading `process.env['R9_REPLYER_LITE_ENABLED']` after this file's tests complete see the same value as before this file ran. Critical because vitest may run files in parallel (`vitest --workers`) — pollution would corrupt other smoke tests that assume R9 OFF by default. (PLAN §7 risk row 3.)

**Prototype-restoration discipline**: `afterEach` restores `MockClaudeClient.prototype.complete` to the snapshotted original. Sibling tests in `replay-runner-mock.test.ts` (parallel file run) rely on the deterministic `[mock:hex8] 好的` behavior; without restore, T-3's patch could leak across.

---

## 3.3 Developer follow-up: spec defect — fixture rawContent vs label.isDirect (NEW 2026-05-05)

During Developer phase (#35) probe execution, the Architect's claim "row 9002 -> reaches R9 gate -> llm-planner" was found to be incorrect:

- The committed `test/fixtures/replay-benchmark-synthetic.jsonl` row 9002 has `label.isDirect = true` (gold/benchmark label). Architect's pin verification at section 0 confirmed only the label.
- However, `rawContent` is `'有人在吗'` — NO `[CQ:at,qq=${BOT_QQ}]` token.
- `chat.ts:1850-1854` (`isDirectForGateBypass`) reads `rawContent` for `[CQ:at,qq=${botUserId}]` (NOT the label). With no @-mention CQ token, row 9002 falls through to non-direct timing gates.
- Consequence: when row 9001 (silent first) runs, `debounceMap.set(groupId, now)` fires; when row 9002 runs immediately after, `now - lastTrigger < debounceMs` triggers silent on `reasonCode='timing'` at chat.ts:1968 — BEFORE reaching the R9 gate at chat.ts:3157. `metaBuilder.setDirective` is never called, `BaseResultMeta.plannerSource` stays `undefined`, `?? null` coerces to `null`. T-3 / T-3c can never observe `'llm-planner'` / `'rule-fallback'`.

**Resolution (chosen by team-lead, option A)**: smoke test (`test/eval/replay-runner-r9-smoke.test.ts`) writes its own one-row inline JSONL fixtures via `writeInlineFixtures(dir, withCqAt=true)` with `rawContent: '[CQ:at,qq=${BOT_QQ}] 在不在'`. Test runs through `runReplay` in single-row mode, no debounce collision, direct-bypass clean, R9 gate reached, `plannerSource` correctly observed. Committed fixture is NOT modified — `replay-runner-mock.test.ts` and future R9.4 baselines continue against the legacy fixture. Probe-confirmed: T-3 produces `plannerSource: 'llm-planner'`, T-3b `'no-planner-skipped'`, T-3c `'rule-fallback'`.

**Test-author breadcrumb for future PRs**: replay-runner test fixtures intended to exercise direct-trigger paths (R9 gate, reply-planner, addressee-regen, etc.) MUST include `[CQ:at,qq=${BOT_QQ}]` in `rawContent`, not just `label.isDirect: true`. Setting only the label is insufficient — `chat.ts:1850-1854` reads rawContent. The committed `test/fixtures/replay-benchmark-synthetic.jsonl` is for testing the harness's row-shaping pipeline, not for exercising the direct-bypass path. Cleanup of the committed fixture is deferred to a separate PR (would change replay-runner-mock-test row counts and requires baseline rebaselining).

**Sub-defect: prototype mutation + super.complete() infinite loop**: Architect's DEV-READY section 3.2 documented this risk and proposed an inline-zero-super fallback. Probe execution confirmed the risk fires: `class PlannerAwareMockClaude extends MockClaudeClient { complete(...) { ...; return super.complete(req); } }` -> assigning `MockClaudeClient.prototype.complete = PlannerAwareMockClaude.prototype.complete` causes `super.complete(req)` to walk to the now-patched parent slot -> infinite recursion -> exception -> `kind: 'error'` row. **Resolution**: inline-fallback adopted. Smoke test defines `defaultMockComplete` (mirror of `MockClaudeClient.complete` body), `plannerAwareComplete`, `throwingPlannerComplete` as plain functions — no `super`, no class subclass. Patches assign `MockClaudeClient.prototype.complete = plannerAwareComplete` directly.

---

## 4. Acceptance gate (mandatory before commit)

Developer runs each step in this order; halts on any failure.

1. **TypeScript**: `cd "D:/QQ-Group-Bot/.claude/worktrees/replay-harness-fix" && npx tsc --noEmit` → 0 errors. Note Windows shell path with quotes.
2. **Smart-quote scan** (`feedback_no_smart_quotes`): `git -C "D:/QQ-Group-Bot/.claude/worktrees/replay-harness-fix" grep -P '[\x{2018}\x{2019}\x{201C}\x{201D}]' -- src/config/reply-planner.ts scripts/eval/replay-runner-core.ts scripts/eval/replay-types.ts test/scripts/eval/replay-harness-r9-wire.test.ts test/eval/replay-runner-r9-smoke.test.ts` → empty.
3. **External-caller grep** (DESIGN §1.5): `git grep -n 'R9_REPLYER_LITE_ENV\b' -- src/ scripts/ test/` → empty.
4. **6 new tests pass**:
   - `npx vitest run test/scripts/eval/replay-harness-r9-wire.test.ts` (3 tests: T-1, T-2, T-2b — all pass).
   - `npx vitest run test/eval/replay-runner-r9-smoke.test.ts` (3 tests: T-3, T-3b, T-3c — all pass).
5. **Full vitest** (regression check): `npx vitest run` from worktree root.
   - Comparison baseline: master `6449849` known pre-existing failures = 15 lore-retrieval (missing fixture) + 1 case-humanization comprehension boundary = 16 failures.
   - Acceptance: total failures on this branch ≤ 16, AND the 16 are the SAME tests that fail on master. Use `git stash && git checkout master && npx vitest run --reporter json > /tmp/master-baseline.json && git checkout - && git stash pop` to capture the baseline if needed.
   - Any NEW failure: halt, fix, re-run.
6. **`replay-runner-mock.test.ts` JSON-stringify tripwire** still passes (line 66: `not.toContain('undefined')`). New `plannerSource` field is `null`-coerced in error branch and `?? null`-coerced elsewhere; should not flip this assertion.
7. **`.claude/` path scan**: `git diff master..HEAD --name-only | grep '\.claude/'` → empty. `.claude/worktrees/` is the worktree mount, NOT the commit content.

If all 7 pass → commit → push.

**Single commit message** (LOCKED — exact text):

```
fix(eval): wire R9 ReplyPlanner into replay-runner harness + regression tests
```

NO `Co-Authored-By` trailer (`feedback_no_coauthor`). Single line. ASCII only. Conventional commit format (`fix:` scope + colon + description).

**Push**: `git push -u origin fix/replay-runner-r9-planner-wire` (Developer-side; Reviewer phase opens the PR per `feedback_gh_pr_create_explicit_base_head` with `gh pr create --base main --head fix/replay-runner-r9-planner-wire`).

---

## 5. Reviewer audit hooks (task #36)

Reviewer (independent) re-runs gates 1-7 above, plus:

8. **spec → impl 1:1 against this DEV-READY**:
   - DEV-READY §2.1 → `src/config/reply-planner.ts` matches the verbatim "After" block.
   - DEV-READY §2.2 → 4 imports added at line 24+.
   - DEV-READY §2.3 → `constructChatModule` body matches verbatim.
   - DEV-READY §2.4 → 5 branches each have the expected `plannerSource` line in the expected position.
   - DEV-READY §2.5 → `ReplayRow.plannerSource` field present in expected position.
   - DEV-READY §3.1 → 3 tests T-1/T-2/T-2b present, names start with `T-N:`.
   - DEV-READY §3.2 → 3 tests T-3/T-3b/T-3c present, names start with `T-N:`.

9. **SMALL real-LLM smoke** (DESIGN §6, briefing §7):
   - Cost cap $0.50; ~5 rows; `R9_REPLYER_LITE_ENABLED=1`; `CHAT_MODEL=gemini-2.5-flash`; real-LLM Gemini.
   - Reviewer command (verbatim from briefing §7):
     ```bash
     R9_REPLYER_LITE_ENABLED=1 CHAT_MODEL=gemini-2.5-flash \
       GEMINI_API_KEY=$(grep '^GEMINI_API_KEY=' /d/QQ-Group-Bot/.env | cut -d= -f2) \
       npx tsx scripts/eval/replay-runner.ts \
         --gold data/eval/gold/gold-1027.jsonl \
         --benchmark data/eval/gold/benchmark-original-781.jsonl \
         --output-dir data/eval/replay/harness-fix-smoke \
         --llm-mode=real --max-cost-usd 0.50 --rps 1 \
         --prod-db data/bot.db --bot-qq 1705075399 \
         --group-id 958751334 --timeout-ms 30000 --limit 5
     ```
   - **APPROVED requires**: ≥1 row in `data/eval/replay/harness-fix-smoke/replay-output.jsonl` has `plannerSource ∈ {'llm-planner', 'rule-fallback'}` (NOT `'no-planner-skipped'` on every row).
   - Reviewer files smoke-evidence (jsonl excerpt) into `.claude/code-reviews.md` "Harness Fix" section before APPROVED.

10. **Reviewer DOES NOT MERGE** (`feedback_never_autonomous_merge_to_default_branch`). On APPROVED: open PR via `gh pr create --base main --head fix/replay-runner-r9-planner-wire`, wait for user gate.

---

## 6. Iteration Contract — Architect DONE state

Per `feedback_iteration_contract_needs_explicit_ack`:

- This DEV-READY is saved at `D:/QQ-Group-Bot/.claude/worktrees/replay-harness-fix/docs/specs/replay-harness-fix-DEV-READY.md`.
- Task #34 marked `completed` via TaskUpdate immediately after save.
- SendMessage to team-lead: `"Harness Fix ARCHITECT DONE, line pins verified at src/config/reply-planner.ts:13-14, scripts/eval/replay-runner-core.ts:58-75, scripts/eval/replay-types.ts:28-66, src/modules/chat.ts:1664/3157/3164/3177/3220-3242/3275, src/modules/reply-planner.ts:128/462/593-602/643-648, fixture row 9002 confirmed direct_at_bot. ~270 LOC across 5 code files + this DEV-READY."`.
- Developer (#35) starts only after team-lead "approved".

---

## 7. Standing rules audit (verbatim, embedded per `feedback_embed_standing_rules_in_agent_briefing`)

- **ASCII single quotes only** — `feedback_no_smart_quotes`. Acceptance gate step 2 verifies. Architect, Designer, Planner spec docs all comply.
- **No emojis** — in code, comments, commit message, test names. Verified during diff review.
- **No `Co-Authored-By` trailer** — `feedback_no_coauthor`. Single-line conventional commit.
- **No `.claude/` paths in commit diff** — acceptance gate step 7 verifies.
- **Edge tests mandatory** — `feedback_edge_testing_soul`. T-2b, T-3b, T-3c are non-negotiable. Reviewer rejects on missing.
- **Conventional commits** — `feedback_commit`. Locked: `fix(eval): wire R9 ReplyPlanner into replay-runner harness + regression tests`.
- **Helpers normalize input internally** — `feedback_normalize_inside_helper`. `isReplyerLiteEnvOn()` reads env directly; `constructChatModule` reads the function. Caller does NOT pass a flag.
- **Validator at every boundary** — `feedback_validator_at_every_boundary`. `chat.setReplyPlanner(p: IReplyPlanner | null)` is the validator; we hand it a real instance OR don't call it. No bypass cast.
- **Metadata on result not side-channel** — `feedback_metadata_on_result_not_side_channel`. Strategy 1 (ReplayRow.plannerSource projected from result.meta) chosen; no side-channel Map.
- **No deprecated alias on clarifying rename** — `feedback_no_deprecated_alias_on_clarifying_rename`. `R9_REPLYER_LITE_ENV` const fully deleted; no back-compat alias.
- **Bot is groupmate not assistant** — `feedback_groupmate_not_assistant_lens`. N/A this PR (no bot-output behavior change).
- **Trusted rules outside untrusted data** — `feedback_trusted_rules_outside_untrusted_data_inside`. N/A this PR (no LLM prompt edit; mock prompts are test-internal canned strings).
- **Reviewer does NOT merge to default branch** — `feedback_never_autonomous_merge_to_default_branch`. APPROVED verdict + open PR + wait for user gate.
- **`gh pr create` explicit base/head** — `feedback_gh_pr_create_explicit_base_head`. Reviewer uses `--base main --head fix/replay-runner-r9-planner-wire`.
- **Worktree CWD discipline** — `feedback_worktree_cwd_drift_misroutes_commits`. Developer always cd's into the worktree OR uses `git -C "D:/QQ-Group-Bot/.claude/worktrees/replay-harness-fix"` for every git command.
