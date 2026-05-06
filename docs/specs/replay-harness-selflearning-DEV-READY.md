# Phase 1 DEV-READY — Wire `selfLearning` into replay-runner harness

**Branch**: `fix/replay-harness-wire-selflearning` (worktree
`D:/QQ-Group-Bot/.claude/worktrees/replay-harness-selflearning/`,
master `ae290a3`).

**Single commit**:
`fix(eval): wire selfLearning into replay-runner harness — close fact retrieval silent-noop trap`

PLAN locked at `docs/specs/replay-harness-selflearning-PLAN.md`.
DESIGN locked at `docs/specs/replay-harness-selflearning-DESIGN.md`.
This DEV-READY pins line numbers verified against current HEAD `ae290a3`
and provides paste-ready diffs + test scaffolds + Reviewer runbook.

---

## 0. Architect pre-flight verification (against HEAD `ae290a3`)

Re-pinned every Designer cite against the worktree's current files:

| Designer cite | Verified at HEAD | Status |
|---|---|---|
| `replay-runner-core.ts:62-102` constructChatModule | `replay-runner-core.ts:62-102` | OK — function decl line 62, return line 101 |
| `replay-runner-core.ts:67-71` tripwire | lines 67-71 | OK |
| `replay-runner-core.ts:72` db open | line 72 | OK |
| `replay-runner-core.ts:73-77` ChatModule ctor | lines 73-77 | OK |
| `replay-runner-core.ts:87-99` ReplyPlanner block | lines 87-99 | OK |
| `replay-runner-core.ts:101` return | line 101 | OK |
| `replay-runner-core.ts:25` ReplyPlanner import | line 25 | OK |
| `replay-runner-core.ts:27` createLogger import | line 27 | OK |
| `src/index.ts:239-243` prod wiring | not re-read; Designer audit accepted | OK |
| `src/modules/self-learning.ts:225-241` ctor | lines 225-241 verbatim | OK |
| `src/modules/self-learning.ts:36-64` `SelfLearningOptions` | lines 36-64 | OK |
| `src/modules/chat.ts:295` `selfLearning?: SelfLearningModule` | line 295 | OK |
| `src/modules/chat.ts:1189` `private readonly selfLearning: SelfLearningModule \| null` | line 1189 | OK |
| `src/modules/chat.ts:2882-2884` short-circuit | lines 2882-2884 | OK |
| `src/storage/db.ts:471-483` `LearnedFactInsertShape` | lines 471-483 | OK |
| `scripts/eval/replay-runner.ts:298-302` only caller of `constructChatModule` | confirmed | OK — only destructures `{ chat, db }` |
| `test/scripts/eval/replay-harness-r9-wire.test.ts` | exists | OK |
| `test/eval/replay-runner-r9-smoke.test.ts` | exists | OK |
| `test/eval/helpers.ts` `snapshotProdDb` / `assertNoProdContamination` | lines 15-35 | OK |
| `scripts/eval/build-synthetic-replay-db.ts:31-71` `buildSyntheticReplayDb` | lines 31-71 | OK |

**No drift detected. Designer pins are accurate.**

### `constructChatModule` callers (tsc-propagation audit — Designer §11.5)

`grep -rn "constructChatModule" D:/QQ-Group-Bot --include="*.ts"`
hits in code:

1. `scripts/eval/replay-runner-core.ts:62` — declaration site.
2. `scripts/eval/replay-runner.ts:33` — import.
3. `scripts/eval/replay-runner.ts:298` — call site,
   destructures `{ chat, db }` only. Extension is backwards-compat;
   no edit needed.
4. `test/scripts/eval/replay-harness-r9-wire.test.ts:6` — import.
5. `test/scripts/eval/replay-harness-r9-wire.test.ts:56,71,83` — call
   sites; tests assert on `result.replyPlanner` / `result.chat` /
   `result.db`. New `selfLearning` field is additive; existing
   assertions unaffected.

Spec docs reference (no code impact):

- `docs/specs/replay-harness-fix-{PLAN,DESIGN,DEV-READY}.md` (PR #179
  spec docs, not code).
- `docs/specs/r6-3-DEV-READY.md` (R6.3 original spec).

**Conclusion: zero callers require updating. Extension is purely
additive at TypeScript level.** DEV-READY locks this — no extra
edits to `replay-runner.ts`, no edits to existing R9-wire test
file.

### vi.mock fork-pool compatibility audit (Designer §11.4)

Searched test suite for prior vi.mock against `replay-runner-core.js`
or sibling files in fork-pool execution context:

- `test/eval/replay-runner-halt-budget.test.ts:30-75` — uses
  `vi.mock('../../scripts/eval/replay-runner-core.js', async (importActual) => {...})`
  with `vi.hoisted(() => ({...}))`. Runs in same fork-pool config as
  `test/eval/replay-runner-r9-smoke.test.ts`. **Proven safe.** vi.mock
  is file-scoped — each test file's hoisted mock factory only
  affects that file's import graph; sibling test files in different
  forks do NOT see the mock. The "cross-file pollution" lesson from
  PR #179 was specifically about **runtime prototype mutation on a
  shared singleton class** (`MockClaudeClient.prototype.complete`
  is a runtime-mutable method on an imported class — sibling test
  files import the same class via the same Node module cache and
  observe the mutation). Class-import mocking via vi.mock is the
  opposite: vitest's hoisted module registry is per-test-file by
  design.

**Decision: T-1c uses `vi.mock` to replace `SelfLearningModule` with a
constructor-throwing subclass.** Rationale:

1. vi.mock is the proven pattern for class-import substitution in
   this codebase (`replay-runner-halt-budget.test.ts` precedent).
2. Prototype-mutation does NOT work for `new` (constructor isn't on
   the prototype at the new-call boundary; `vi.spyOn` on
   `'constructor'` is not feasible).
3. Forcing a constructor throw via a "broken `db` arg" approach
   fails because `SelfLearningModule` constructor only stores fields
   — never validates. There's no runtime path inside the constructor
   that can be made to throw without modifying production code,
   which is out of scope per PLAN §3.
4. File-scoped vi.mock contains the substitution to T-1c only; T-1
   and T-1b in the same file see the mocked class but their
   assertion `result.selfLearning instanceof SelfLearningModule`
   uses the *imported* (mocked) `SelfLearningModule` symbol — the
   subclass extends the actual module, so `instanceof` still
   matches. We side-step by gating the throw on
   `botUserId === 'force-throw'` sentinel; T-1 and T-1b pass
   `botQQ: 'bot-test'` which falls through to `super(...args)` and
   the real constructor runs.

**Cross-file pollution check**: vi.mock factory at the top of
`test/scripts/eval/replay-harness-self-learning-wire.test.ts` only
affects that file's module graph. Sibling test files
(`replay-harness-r9-wire.test.ts`, `replay-runner-r9-smoke.test.ts`,
`replay-runner-self-learning-smoke.test.ts`) import
`SelfLearningModule` indirectly via `constructChatModule` and get
the real class through their own module graph. **Confirmed safe.**

---

## 1. Verbatim diff plan — `scripts/eval/replay-runner-core.ts`

Apply five edits in this order (no other edits to this file). All
line numbers reference current HEAD `ae290a3` AS IT EXISTS BEFORE
applying any of these edits.

### Edit §1.1 — Add `SelfLearningModule` import

**Location**: after line 25, before line 26 (insert as new line; the
existing `ReplyPlanner` import stays untouched).

**Before** (lines 25-26):

```ts
import { ReplyPlanner } from '../../src/modules/reply-planner.js';
import type { IReplyPlanner } from '../../src/modules/reply-planner.js';
```

**After**:

```ts
import { ReplyPlanner } from '../../src/modules/reply-planner.js';
import type { IReplyPlanner } from '../../src/modules/reply-planner.js';
import { SelfLearningModule } from '../../src/modules/self-learning.js';
```

### Edit §1.2 — Extend function return type signature

**Location**: line 66.

**Before**:

```ts
}): { chat: ChatModule; db: Database; replyPlanner: IReplyPlanner | null } {
```

**After**:

```ts
}): {
  chat: ChatModule;
  db: Database;
  replyPlanner: IReplyPlanner | null;
  selfLearning: SelfLearningModule | null;
} {
```

### Edit §1.3 — Insert `selfLearning` try/catch block + thread to ChatModule ctor

**Location**: between lines 72 and 73 (after `const db = new
Database(args.tmpDbPath);`, before `const chat = new ChatModule(...)`).
Add the `selfLearning` field to the ChatModule ctor options.

**Before** (lines 72-77):

```ts
  const db = new Database(args.tmpDbPath);
  const chat = new ChatModule(args.mockClaude, db, {
    botUserId: args.botQQ,
    moodProactiveEnabled: false,
    deflectCacheEnabled: false,
  });
```

**After**:

```ts
  const db = new Database(args.tmpDbPath);

  // Wire SelfLearningModule mirroring src/index.ts:239-243 production wiring,
  // with embedder=null (Phase 2 sub-PR adds embedder) and researchEnabled=false
  // (harness-only, no online network calls). Fail-open on construct error
  // mirrors the R9 ReplyPlanner block below — harness keeps running so other
  // tests still get coverage. Closes the chat.ts:2882-2884 silent-noop trap
  // identified in r9-retrieval-signal-audit-2026-05-05.md.
  let selfLearning: SelfLearningModule | null = null;
  try {
    selfLearning = new SelfLearningModule({
      db,
      claude: args.mockClaude,
      botUserId: args.botQQ,
      embeddingService: null,
      researchEnabled: false,
      logger: createLogger('self-learning-replay'),
    });
  } catch (err) {
    createLogger('replay-runner-core').warn(
      { err: String(err) },
      'selfLearning not wired in harness — continuing without',
    );
    selfLearning = null;
  }

  const chat = new ChatModule(args.mockClaude, db, {
    botUserId: args.botQQ,
    moodProactiveEnabled: false,
    deflectCacheEnabled: false,
    selfLearning: selfLearning ?? undefined,
  });
```

**Why `selfLearning ?? undefined`**: `ChatOptions.selfLearning` is
`SelfLearningModule | undefined` (chat.ts:295); passing `null`
directly would fail TS. Internal field at chat.ts:1189 is
`SelfLearningModule | null`; the `?? null` coercion happens inside
ChatModule's constructor. The null-arm and undefined-arm both
resolve to `this.selfLearning === null`.

### Edit §1.4 — Extend return statement

**Location**: line 101.

**Before**:

```ts
  return { chat, db, replyPlanner };
```

**After**:

```ts
  return { chat, db, replyPlanner, selfLearning };
```

### Edit §1.5 — Verify no other edits

The R9 ReplyPlanner try/catch block at lines 87-99 stays UNTOUCHED.
The `chat.setReplyPlanner(replyPlanner)` post-construction call at
line 91 still runs after `new ChatModule(...)` — no ordering change.

**Total LOC delta in `replay-runner-core.ts`**: +24 LOC (1 import +
4-line return type expansion + 17-line try/catch block + 1-line
options field + 1-line return extension).

---

## 2. Test file scaffold — `test/scripts/eval/replay-harness-self-learning-wire.test.ts`

Paste-ready. Copy verbatim into the worktree.

```ts
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// vi.mock MUST be hoisted above any import of the module under test.
// Replaces SelfLearningModule with a subclass that throws on `new` when
// botUserId === 'force-throw' sentinel (T-1c). Falls through to the real
// constructor for T-1 and T-1b (botQQ: 'bot-test'). File-scoped — does NOT
// affect sibling test files per vitest's per-file module-graph isolation
// (see DEV-READY §0 vi.mock fork-pool audit).
vi.mock('../../../src/modules/self-learning.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/modules/self-learning.js')>(
    '../../../src/modules/self-learning.js',
  );
  return {
    ...actual,
    SelfLearningModule: class extends actual.SelfLearningModule {
      constructor(...args: ConstructorParameters<typeof actual.SelfLearningModule>) {
        if ((args[0] as { botUserId?: string }).botUserId === 'force-throw') {
          throw new Error('forced ctor throw for T-1c');
        }
        super(...args);
      }
    },
  };
});

import { constructChatModule } from '../../../scripts/eval/replay-runner-core.js';
import { MockClaudeClient } from '../../../scripts/eval/mock-llm.js';
import { SelfLearningModule } from '../../../src/modules/self-learning.js';
import { buildSyntheticReplayDb } from '../../../scripts/eval/build-synthetic-replay-db.js';

const REPO = path.resolve(__dirname, '../../..');
// Dedicated synthetic fixture path for this file. Filename contains
// 'synthetic' so the constructChatModule tripwire is satisfied.
const FIXTURE_DB_SRC = path.join(
  REPO,
  'test/fixtures/replay-prod-db-synthetic-selflearning-wire.sqlite',
);

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `selflearning-wire-${prefix}-`));
}

function makeTmpDb(prefix: string): string {
  const dir = tmpDir(prefix);
  const dst = path.join(dir, 'synthetic.db');
  fs.copyFileSync(FIXTURE_DB_SRC, dst);
  return dst;
}

describe('replay-runner harness — selfLearning wire (T-1 / T-1b / T-1c)', () => {
  beforeAll(() => {
    // Build synthetic fixture once. Per-test rebuild races sibling parallel
    // test files that build other dedicated fixture paths.
    buildSyntheticReplayDb(FIXTURE_DB_SRC);
  });

  it('T-1: constructChatModule returns non-null selfLearning when ctor succeeds', () => {
    const tmpDb = makeTmpDb('t1');
    const mockClaude = new MockClaudeClient();
    const result = constructChatModule({
      tmpDbPath: tmpDb,
      botQQ: 'bot-test',
      mockClaude,
    });
    expect(result.chat).toBeDefined();
    expect(result.db).toBeDefined();
    expect(result.selfLearning).not.toBeNull();
  });

  it('T-1b: wired selfLearning is a SelfLearningModule instance', () => {
    const tmpDb = makeTmpDb('t1b');
    const mockClaude = new MockClaudeClient();
    const result = constructChatModule({
      tmpDbPath: tmpDb,
      botQQ: 'bot-test',
      mockClaude,
    });
    // SelfLearningModule symbol resolves to the mocked subclass (vi.mock
    // factory above), but the subclass extends the real class — instanceof
    // matches the mocked class which IS the SelfLearningModule for this
    // test file's module graph.
    expect(result.selfLearning).toBeInstanceOf(SelfLearningModule);
  });

  it('T-1c (edge): SelfLearningModule ctor throw -> result.selfLearning === null, harness still returns chat+db', () => {
    const tmpDb = makeTmpDb('t1c');
    const mockClaude = new MockClaudeClient();
    // Sentinel value triggers the mocked subclass constructor to throw.
    // Wire's try/catch must catch and fail-open with selfLearning = null.
    const result = constructChatModule({
      tmpDbPath: tmpDb,
      botQQ: 'force-throw',
      mockClaude,
    });
    expect(result.selfLearning).toBeNull();
    expect(result.chat).toBeDefined();
    expect(result.db).toBeDefined();
  });
});
```

**Total scaffold LOC**: ~85 LOC.

---

## 3. Test file scaffold — `test/eval/replay-runner-self-learning-smoke.test.ts`

Paste-ready. Copy verbatim into the worktree.

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runReplay } from '../../scripts/eval/replay-runner.js';
import type { ReplayerArgs } from '../../scripts/eval/replay-types.js';
import { buildSyntheticReplayDb } from '../../scripts/eval/build-synthetic-replay-db.js';
import { Database } from '../../src/storage/db.js';
import { snapshotProdDb, assertNoProdContamination } from './helpers.js';

const BOT_QQ = '1705075399';
const GROUP_ID = '958751334';
const REPO = path.resolve(__dirname, '../..');

// Dedicated synthetic fixture paths — one seeded with the smoke fact, one
// empty. Filenames contain 'synthetic' so the constructChatModule tripwire
// is satisfied. Dedicated paths prevent races with sibling test files in
// vitest fork-pool.
const FIXTURE_DB_FACT = path.join(
  REPO,
  'test/fixtures/replay-prod-db-synthetic-selflearning.sqlite',
);
const FIXTURE_DB_EMPTY = path.join(
  REPO,
  'test/fixtures/replay-prod-db-synthetic-selflearning-empty.sqlite',
);

// Capture the seeded fact id at beforeAll so T-2 can assert it appears in
// matchedFactIds.
let seededFactId: number | null = null;

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `selflearning-smoke-${prefix}-`));
}

interface InlineFixturePaths {
  goldPath: string;
  benchmarkPath: string;
}

/**
 * Write a single-row gold + benchmark JSONL with a customizable trigger.
 * rawContent is constructed with a [CQ:at,qq=BOT_QQ] prefix so ChatModule's
 * direct-bypass at chat.ts:1850-1854 fires — bypasses timing-debounce and
 * reaches the selfLearning short-circuit at chat.ts:2882-2884. Without the
 * CQ-at prefix, debounce silences before retrieval ever runs. Same lesson
 * as PR #179 replay-runner-r9-smoke.test.ts:24-37.
 */
function writeInlineFixtures(
  dir: string,
  opts: { sampleId: string; messageId: number; content: string; hasKnownFactTerm: boolean; hasRealFactHit: boolean },
): InlineFixturePaths {
  const goldPath = path.join(dir, 'gold.jsonl');
  const benchmarkPath = path.join(dir, 'benchmark.jsonl');
  const rawContent = `[CQ:at,qq=${BOT_QQ}] ${opts.content}`;
  fs.writeFileSync(goldPath, JSON.stringify({
    sampleId: opts.sampleId,
    goldAct: 'direct_chat',
    goldDecision: 'reply',
    targetOk: true,
    factNeeded: opts.hasKnownFactTerm,
    allowBanter: true,
    allowSticker: false,
    labeledAt: '2026-05-05T00:00:00Z',
  }) + '\n');
  fs.writeFileSync(benchmarkPath, JSON.stringify({
    id: opts.sampleId,
    groupId: GROUP_ID,
    messageId: opts.messageId,
    sourceMessageId: `src-${opts.messageId}`,
    userId: 'U1100',
    nickname: '王五',
    timestamp: 1_713_001_000,
    content: opts.content,
    rawContent,
    triggerContext: [],
    triggerContextAfter: [],
    category: 1,
    categoryLabel: 'direct_at_bot',
    samplingSeed: 1,
    contentHash: `ch-${opts.messageId}`,
    contextHash: `cx-${opts.messageId}`,
    label: {
      expectedAct: 'direct_chat',
      expectedDecision: 'reply',
      hasKnownFactTerm: opts.hasKnownFactTerm,
      knownFactSource: opts.hasKnownFactTerm ? 'moegirl' : null,
      hasRealFactHit: opts.hasRealFactHit,
      allowPluralYou: false,
      isObjectReact: false,
      isBotStatusContext: false,
      isBurst: false,
      isRelay: false,
      isDirect: true,
      riskFlags: [],
    },
  }) + '\n');
  return { goldPath, benchmarkPath };
}

function makeArgs(outputDir: string, fixturePath: string, fixtures: InlineFixturePaths): ReplayerArgs {
  return {
    goldPath: fixtures.goldPath,
    benchmarkPath: fixtures.benchmarkPath,
    outputDir,
    llmMode: 'mock',
    limit: null,
    prodDbPath: fixturePath,
    botQQ: BOT_QQ,
    groupIdForReplay: GROUP_ID,
    perSampleTimeoutMs: 10_000,
    maxCostUsd: null,
    rateLimitRps: null,
    retryMax: null,
    maxConsecutiveErrors: null,
  };
}

describe('replay-runner — selfLearning smoke (T-2 / T-2b / T-2c)', () => {
  beforeAll(() => {
    // Fact-seeded fixture
    buildSyntheticReplayDb(FIXTURE_DB_FACT);
    const dbWithFact = new Database(FIXTURE_DB_FACT);
    const inserted = dbWithFact.learnedFacts.insertOrSupersede({
      groupId: GROUP_ID,
      topic: 'moegirl:高松灯',
      fact: '高松灯 = MyGO!!!!! 主唱',
      canonicalForm: '高松灯',
      personaForm: null,
      sourceUserId: null,
      sourceUserNickname: 'moegirl-seed',
      sourceMsgId: null,
      botReplyId: null,
      confidence: 0.95,
      status: 'active',
    });
    seededFactId = inserted.newId;
    try {
      (dbWithFact as unknown as { rawDb?: { close?: () => void } }).rawDb?.close?.();
    } catch { /* ignore */ }

    // Empty-DB fixture (no fact insert; just buildSyntheticReplayDb's 2
    // baseline messages, zero facts).
    buildSyntheticReplayDb(FIXTURE_DB_EMPTY);
  });

  it('T-2: wired + DB-has-fact + matching trigger -> matchedFactIds populated', async () => {
    const outDir = tmpDir('t2');
    const fixtures = writeInlineFixtures(outDir, {
      sampleId: '958751334:9100',
      messageId: 9100,
      content: '高松灯是谁',
      hasKnownFactTerm: true,
      hasRealFactHit: true,
    });
    const before = snapshotProdDb(FIXTURE_DB_FACT);
    const result = await runReplay(makeArgs(outDir, FIXTURE_DB_FACT, fixtures));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBeGreaterThan(0);

    const lines = fs.readFileSync(path.join(outDir, 'replay-output.jsonl'), 'utf8')
      .trim().split('\n').filter(l => l.length > 0);
    const replyRows = lines
      .map(l => JSON.parse(l))
      .filter(r => r.resultKind === 'reply');
    expect(replyRows.length).toBeGreaterThan(0);

    const withMatched = replyRows.filter(r => Array.isArray(r.matchedFactIds) && r.matchedFactIds.length > 0);
    expect(withMatched.length).toBeGreaterThan(0);
    expect(seededFactId).not.toBeNull();
    expect(withMatched[0].matchedFactIds).toContain(seededFactId);

    assertNoProdContamination(FIXTURE_DB_FACT, before);
  }, 30_000);

  it('T-2b (edge): wired + DB-has-fact + non-fact trigger -> matchedFactIds === []', async () => {
    const outDir = tmpDir('t2b');
    const fixtures = writeInlineFixtures(outDir, {
      sampleId: '958751334:9101',
      messageId: 9101,
      content: '随便聊聊',
      hasKnownFactTerm: false,
      hasRealFactHit: false,
    });
    const before = snapshotProdDb(FIXTURE_DB_FACT);
    const result = await runReplay(makeArgs(outDir, FIXTURE_DB_FACT, fixtures));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBeGreaterThan(0);

    const lines = fs.readFileSync(path.join(outDir, 'replay-output.jsonl'), 'utf8')
      .trim().split('\n').filter(l => l.length > 0);
    const replyRows = lines
      .map(l => JSON.parse(l))
      .filter(r => r.resultKind === 'reply');
    expect(replyRows.length).toBeGreaterThan(0);

    // Non-fact trigger: no entity match. matchedFactIds should be empty for
    // every reply row. (injectedFactIds may be non-empty via pinned-newest /
    // recency populating with the seeded 高松灯 row — that's fine.)
    for (const row of replyRows) {
      expect(Array.isArray(row.matchedFactIds)).toBe(true);
      expect(row.matchedFactIds).toEqual([]);
    }

    assertNoProdContamination(FIXTURE_DB_FACT, before);
  }, 30_000);

  it('T-2c (edge, silent-noop guard): wired + EMPTY DB + matching trigger -> matchedFactIds === [] AND injectedFactIds === []', async () => {
    const outDir = tmpDir('t2c');
    const fixtures = writeInlineFixtures(outDir, {
      sampleId: '958751334:9102',
      messageId: 9102,
      content: '高松灯是谁',
      hasKnownFactTerm: true,
      hasRealFactHit: false,
    });
    const before = snapshotProdDb(FIXTURE_DB_EMPTY);
    const result = await runReplay(makeArgs(outDir, FIXTURE_DB_EMPTY, fixtures));
    expect(result.exitCode).toBe(0);
    expect(result.rowsWritten).toBeGreaterThan(0);

    const lines = fs.readFileSync(path.join(outDir, 'replay-output.jsonl'), 'utf8')
      .trim().split('\n').filter(l => l.length > 0);
    const replyRows = lines
      .map(l => JSON.parse(l))
      .filter(r => r.resultKind === 'reply');
    expect(replyRows.length).toBeGreaterThan(0);

    // Empty-DB + matching trigger: retrieval RAN (selfLearning is wired) but
    // returned nothing because there are no facts. This is the silent-noop
    // FINGERPRINT but here it's CORRECT behavior. T-2 + T-2c together rule
    // out the pre-fix universal-empty bug: T-2 proves non-empty achievable,
    // T-2c proves empty-when-truly-empty achievable.
    for (const row of replyRows) {
      expect(Array.isArray(row.matchedFactIds)).toBe(true);
      expect(row.matchedFactIds).toEqual([]);
      expect(Array.isArray(row.injectedFactIds)).toBe(true);
      expect(row.injectedFactIds).toEqual([]);
    }

    assertNoProdContamination(FIXTURE_DB_EMPTY, before);
  }, 30_000);
});
```

**Total scaffold LOC**: ~210 LOC.

---

## 4. Reviewer runbook — option B inline benchmark for smoke replay

Per Designer §7 recommendation, use option B (inline JSONL) for
fully-deterministic smoke verification. The 10-row inline benchmark
includes a `高松灯是谁` trigger that hits Path A against prod-db
(prod-db has 10 active facts under topic prefix `moegirl:高松灯`
per audit, line 75-77).

### 4.1 Worktree-local script path (mandatory)

```bash
cd D:/QQ-Group-Bot/.claude/worktrees/replay-harness-selflearning
```

### 4.2 Write inline 10-row benchmark JSONL

Reviewer creates a tmp dir and writes the gold + benchmark JSONL
inline. Each row uses a `[CQ:at,qq=1705075399]` prefix to bypass
timing-debounce and reach the selfLearning short-circuit.

```bash
TMPOUT=$(mktemp -d)
GOLD="$TMPOUT/gold.jsonl"
BENCH="$TMPOUT/benchmark.jsonl"
OUTDIR="data/eval/replay/selflearning-smoke"
```

Bash here-doc for `gold.jsonl` (10 rows):

```bash
cat > "$GOLD" <<'GOLDEOF'
{"sampleId":"958751334:9201","goldAct":"direct_chat","goldDecision":"reply","targetOk":true,"factNeeded":true,"allowBanter":true,"allowSticker":false,"labeledAt":"2026-05-05T00:00:00Z"}
{"sampleId":"958751334:9202","goldAct":"direct_chat","goldDecision":"reply","targetOk":true,"factNeeded":false,"allowBanter":true,"allowSticker":false,"labeledAt":"2026-05-05T00:00:00Z"}
{"sampleId":"958751334:9203","goldAct":"direct_chat","goldDecision":"reply","targetOk":true,"factNeeded":true,"allowBanter":true,"allowSticker":false,"labeledAt":"2026-05-05T00:00:00Z"}
{"sampleId":"958751334:9204","goldAct":"direct_chat","goldDecision":"reply","targetOk":true,"factNeeded":false,"allowBanter":true,"allowSticker":false,"labeledAt":"2026-05-05T00:00:00Z"}
{"sampleId":"958751334:9205","goldAct":"direct_chat","goldDecision":"reply","targetOk":true,"factNeeded":true,"allowBanter":true,"allowSticker":false,"labeledAt":"2026-05-05T00:00:00Z"}
{"sampleId":"958751334:9206","goldAct":"direct_chat","goldDecision":"reply","targetOk":true,"factNeeded":false,"allowBanter":true,"allowSticker":false,"labeledAt":"2026-05-05T00:00:00Z"}
{"sampleId":"958751334:9207","goldAct":"direct_chat","goldDecision":"reply","targetOk":true,"factNeeded":true,"allowBanter":true,"allowSticker":false,"labeledAt":"2026-05-05T00:00:00Z"}
{"sampleId":"958751334:9208","goldAct":"direct_chat","goldDecision":"reply","targetOk":true,"factNeeded":false,"allowBanter":true,"allowSticker":false,"labeledAt":"2026-05-05T00:00:00Z"}
{"sampleId":"958751334:9209","goldAct":"direct_chat","goldDecision":"reply","targetOk":true,"factNeeded":true,"allowBanter":true,"allowSticker":false,"labeledAt":"2026-05-05T00:00:00Z"}
{"sampleId":"958751334:9210","goldAct":"direct_chat","goldDecision":"reply","targetOk":true,"factNeeded":false,"allowBanter":true,"allowSticker":false,"labeledAt":"2026-05-05T00:00:00Z"}
GOLDEOF
```

Bash here-doc for `benchmark.jsonl` (10 rows; 5 fact-bearing
triggers interleaved with 5 banter triggers — Reviewer expects ≥1
of the fact-bearing rows to land non-empty `matchedFactIds`):

```bash
cat > "$BENCH" <<'BENCHEOF'
{"id":"958751334:9201","groupId":"958751334","messageId":9201,"sourceMessageId":"src-9201","userId":"U1100","nickname":"群友A","timestamp":1713001001,"content":"高松灯是谁","rawContent":"[CQ:at,qq=1705075399] 高松灯是谁","triggerContext":[],"triggerContextAfter":[],"category":1,"categoryLabel":"direct_at_bot","samplingSeed":1,"contentHash":"h9201","contextHash":"x9201","label":{"expectedAct":"direct_chat","expectedDecision":"reply","hasKnownFactTerm":true,"knownFactSource":"moegirl","hasRealFactHit":true,"allowPluralYou":false,"isObjectReact":false,"isBotStatusContext":false,"isBurst":false,"isRelay":false,"isDirect":true,"riskFlags":[]}}
{"id":"958751334:9202","groupId":"958751334","messageId":9202,"sourceMessageId":"src-9202","userId":"U1101","nickname":"群友B","timestamp":1713001002,"content":"今天天气怎么样","rawContent":"[CQ:at,qq=1705075399] 今天天气怎么样","triggerContext":[],"triggerContextAfter":[],"category":1,"categoryLabel":"direct_at_bot","samplingSeed":1,"contentHash":"h9202","contextHash":"x9202","label":{"expectedAct":"direct_chat","expectedDecision":"reply","hasKnownFactTerm":false,"knownFactSource":null,"hasRealFactHit":false,"allowPluralYou":false,"isObjectReact":false,"isBotStatusContext":false,"isBurst":false,"isRelay":false,"isDirect":true,"riskFlags":[]}}
{"id":"958751334:9203","groupId":"958751334","messageId":9203,"sourceMessageId":"src-9203","userId":"U1102","nickname":"群友C","timestamp":1713001003,"content":"拉神是谁","rawContent":"[CQ:at,qq=1705075399] 拉神是谁","triggerContext":[],"triggerContextAfter":[],"category":1,"categoryLabel":"direct_at_bot","samplingSeed":1,"contentHash":"h9203","contextHash":"x9203","label":{"expectedAct":"direct_chat","expectedDecision":"reply","hasKnownFactTerm":true,"knownFactSource":"moegirl","hasRealFactHit":true,"allowPluralYou":false,"isObjectReact":false,"isBotStatusContext":false,"isBurst":false,"isRelay":false,"isDirect":true,"riskFlags":[]}}
{"id":"958751334:9204","groupId":"958751334","messageId":9204,"sourceMessageId":"src-9204","userId":"U1103","nickname":"群友D","timestamp":1713001004,"content":"在干嘛","rawContent":"[CQ:at,qq=1705075399] 在干嘛","triggerContext":[],"triggerContextAfter":[],"category":1,"categoryLabel":"direct_at_bot","samplingSeed":1,"contentHash":"h9204","contextHash":"x9204","label":{"expectedAct":"direct_chat","expectedDecision":"reply","hasKnownFactTerm":false,"knownFactSource":null,"hasRealFactHit":false,"allowPluralYou":false,"isObjectReact":false,"isBotStatusContext":false,"isBurst":false,"isRelay":false,"isDirect":true,"riskFlags":[]}}
{"id":"958751334:9205","groupId":"958751334","messageId":9205,"sourceMessageId":"src-9205","userId":"U1104","nickname":"群友E","timestamp":1713001005,"content":"高松灯哪个团","rawContent":"[CQ:at,qq=1705075399] 高松灯哪个团","triggerContext":[],"triggerContextAfter":[],"category":1,"categoryLabel":"direct_at_bot","samplingSeed":1,"contentHash":"h9205","contextHash":"x9205","label":{"expectedAct":"direct_chat","expectedDecision":"reply","hasKnownFactTerm":true,"knownFactSource":"moegirl","hasRealFactHit":true,"allowPluralYou":false,"isObjectReact":false,"isBotStatusContext":false,"isBurst":false,"isRelay":false,"isDirect":true,"riskFlags":[]}}
{"id":"958751334:9206","groupId":"958751334","messageId":9206,"sourceMessageId":"src-9206","userId":"U1105","nickname":"群友F","timestamp":1713001006,"content":"刚才好热闹","rawContent":"[CQ:at,qq=1705075399] 刚才好热闹","triggerContext":[],"triggerContextAfter":[],"category":1,"categoryLabel":"direct_at_bot","samplingSeed":1,"contentHash":"h9206","contextHash":"x9206","label":{"expectedAct":"direct_chat","expectedDecision":"reply","hasKnownFactTerm":false,"knownFactSource":null,"hasRealFactHit":false,"allowPluralYou":false,"isObjectReact":false,"isBotStatusContext":false,"isBurst":false,"isRelay":false,"isDirect":true,"riskFlags":[]}}
{"id":"958751334:9207","groupId":"958751334","messageId":9207,"sourceMessageId":"src-9207","userId":"U1106","nickname":"群友G","timestamp":1713001007,"content":"羊宫妃那是谁","rawContent":"[CQ:at,qq=1705075399] 羊宫妃那是谁","triggerContext":[],"triggerContextAfter":[],"category":1,"categoryLabel":"direct_at_bot","samplingSeed":1,"contentHash":"h9207","contextHash":"x9207","label":{"expectedAct":"direct_chat","expectedDecision":"reply","hasKnownFactTerm":true,"knownFactSource":"moegirl","hasRealFactHit":true,"allowPluralYou":false,"isObjectReact":false,"isBotStatusContext":false,"isBurst":false,"isRelay":false,"isDirect":true,"riskFlags":[]}}
{"id":"958751334:9208","groupId":"958751334","messageId":9208,"sourceMessageId":"src-9208","userId":"U1107","nickname":"群友H","timestamp":1713001008,"content":"无聊","rawContent":"[CQ:at,qq=1705075399] 无聊","triggerContext":[],"triggerContextAfter":[],"category":1,"categoryLabel":"direct_at_bot","samplingSeed":1,"contentHash":"h9208","contextHash":"x9208","label":{"expectedAct":"direct_chat","expectedDecision":"reply","hasKnownFactTerm":false,"knownFactSource":null,"hasRealFactHit":false,"allowPluralYou":false,"isObjectReact":false,"isBotStatusContext":false,"isBurst":false,"isRelay":false,"isDirect":true,"riskFlags":[]}}
{"id":"958751334:9209","groupId":"958751334","messageId":9209,"sourceMessageId":"src-9209","userId":"U1108","nickname":"群友I","timestamp":1713001009,"content":"高松灯生日","rawContent":"[CQ:at,qq=1705075399] 高松灯生日","triggerContext":[],"triggerContextAfter":[],"category":1,"categoryLabel":"direct_at_bot","samplingSeed":1,"contentHash":"h9209","contextHash":"x9209","label":{"expectedAct":"direct_chat","expectedDecision":"reply","hasKnownFactTerm":true,"knownFactSource":"moegirl","hasRealFactHit":true,"allowPluralYou":false,"isObjectReact":false,"isBotStatusContext":false,"isBurst":false,"isRelay":false,"isDirect":true,"riskFlags":[]}}
{"id":"958751334:9210","groupId":"958751334","messageId":9210,"sourceMessageId":"src-9210","userId":"U1109","nickname":"群友J","timestamp":1713001010,"content":"睡觉了","rawContent":"[CQ:at,qq=1705075399] 睡觉了","triggerContext":[],"triggerContextAfter":[],"category":1,"categoryLabel":"direct_at_bot","samplingSeed":1,"contentHash":"h9210","contextHash":"x9210","label":{"expectedAct":"direct_chat","expectedDecision":"reply","hasKnownFactTerm":false,"knownFactSource":null,"hasRealFactHit":false,"allowPluralYou":false,"isObjectReact":false,"isBotStatusContext":false,"isBurst":false,"isRelay":false,"isDirect":true,"riskFlags":[]}}
BENCHEOF
```

### 4.3 Run smoke replay (worktree-local script)

```bash
NODE_OPTIONS=--experimental-sqlite \
  npx tsx scripts/eval/replay-runner.ts \
    --gold "$GOLD" \
    --benchmark "$BENCH" \
    --output "$OUTDIR" \
    --prod-db D:/QQ-Group-Bot/data/bot.db \
    --bot-qq 1705075399 \
    --group 958751334 \
    --limit 10 \
    --llm-mode mock
```

### 4.4 Acceptance check

Reviewer parses `$OUTDIR/replay-output.jsonl`:

```bash
cat "$OUTDIR/replay-output.jsonl" | jq -c 'select(.resultKind=="reply") | {id: .sampleId, matched: .matchedFactIds, injected: .injectedFactIds}'
```

**Expected**: at least one row from sample IDs 9201, 9203, 9205, 9207,
9209 (the fact-bearing triggers) has `matchedFactIds.length > 0`.
The matched id resolves to a real prod-db `learned_facts` row:

```bash
sqlite3 D:/QQ-Group-Bot/data/bot.db "select id, topic, fact, status from learned_facts where id = $MATCHED_ID;"
```

Status must be `'active'`, topic must start with `'moegirl:'`,
fact must be non-empty.

### 4.5 Pre-fix regression check (negative control)

If Reviewer is in doubt, run the same command from MASTER tree
(NOT worktree). Pre-fix: ALL 10 reply rows have
`matchedFactIds === []` AND `injectedFactIds === []` (the
silent-noop fingerprint). Post-fix on the worktree: ≥1 row has
`matchedFactIds.length > 0`. The diff between master and worktree
output is the smoking gun.

---

## 5. Iteration Contract

| File | Status | Change | Size |
|---|---|---|---|
| `scripts/eval/replay-runner-core.ts` | MODIFIED | + SelfLearningModule import (1 LOC) <br>+ try/catch wire block (17 LOC) <br>+ ChatModule ctor opts field (1 LOC) <br>+ return type expansion (4 LOC) <br>+ return statement extension (1 LOC) | +24 LOC |
| `test/scripts/eval/replay-harness-self-learning-wire.test.ts` | NEW | T-1 / T-1b / T-1c harness-level + vi.mock | ~85 LOC |
| `test/eval/replay-runner-self-learning-smoke.test.ts` | NEW | T-2 / T-2b / T-2c smoke-level + inline JSONL writer | ~210 LOC |
| `test/fixtures/replay-prod-db-synthetic-selflearning-wire.sqlite` | NEW (binary) | Built by `buildSyntheticReplayDb` in `beforeAll` (NOT committed, generated per-run; NOT in git) | n/a |
| `test/fixtures/replay-prod-db-synthetic-selflearning.sqlite` | NEW (binary) | Same — generated, NOT in git | n/a |
| `test/fixtures/replay-prod-db-synthetic-selflearning-empty.sqlite` | NEW (binary) | Same — generated, NOT in git | n/a |
| `docs/specs/replay-harness-selflearning-PLAN.md` | NEW | Spec doc | included |
| `docs/specs/replay-harness-selflearning-DESIGN.md` | NEW | Spec doc | included |
| `docs/specs/replay-harness-selflearning-DEV-READY.md` | NEW | Spec doc (this file) | included |
| **Total code-side** | | | ~320 LOC |

**Important — synthetic fixtures are NOT committed**: the three
`replay-prod-db-synthetic-selflearning*.sqlite` files are built by
`buildSyntheticReplayDb` in test `beforeAll` blocks. PR #179 follows
the same convention (`replay-prod-db-synthetic-r9smoke.sqlite` and
`replay-prod-db-synthetic-r9wire.sqlite` are NOT in `git ls-files`).
Confirmed via `git ls-files test/fixtures/ | grep synthetic` — only
`replay-prod-db-synthetic.sqlite` (the canonical one) is tracked.
Developer must verify `.gitignore` covers `test/fixtures/*synthetic*sqlite`
or that the new fixture filenames match the existing untracked pattern.

---

## 6. Acceptance criteria (Developer DONE gate)

- `cd D:/QQ-Group-Bot/.claude/worktrees/replay-harness-selflearning && npx tsc --noEmit` → 0 errors.
- All 6 new tests pass:
  `npx vitest run test/scripts/eval/replay-harness-self-learning-wire.test.ts test/eval/replay-runner-self-learning-smoke.test.ts`
- Full vitest run shows no NEW regressions vs master `ae290a3`:
  `npx vitest run` — every test that passes on `ae290a3` still
  passes on the worktree branch.
- ASCII single quotes only (smart quote scan empty):
  `grep -rn "[‘’“”]" scripts/eval/replay-runner-core.ts test/scripts/eval/replay-harness-self-learning-wire.test.ts test/eval/replay-runner-self-learning-smoke.test.ts` → no hits.
- No emojis anywhere in code, tests, or commit message.
- No `Co-Authored-By` line in commit.
- No `.claude/` paths in commit (worktree internal docs stay
  local-only; only `scripts/eval/` and `test/` files in commit;
  the three spec docs under `docs/specs/` ARE committed since
  they're under the worktree's `docs/` not `.claude/`).
- Single commit:
  `fix(eval): wire selfLearning into replay-runner harness — close fact retrieval silent-noop trap`
- Conventional-commits format.
- Helpers normalize input internally (no test-side normalization
  duplicated).
- Validators at every boundary preserved (no validator removed).

---

## 7. Reviewer audit hooks (Phase 1 Reviewer task #54)

Reviewer must:

1. **Re-run `tsc`** from worktree:
   `cd <worktree> && npx tsc --noEmit` → 0 errors.
2. **Run all 6 new tests + full vitest** — confirm no regressions
   vs `ae290a3`.
3. **ASCII quote scan** — verify zero smart quotes in modified files.
4. **Spec→impl 1:1 vs DEV-READY §1** — line-by-line verify the diff
   in `replay-runner-core.ts` matches §1.1-1.4.
5. **Worktree-local smoke replay** per DEV-READY §4 — verify ≥1 row
   has `matchedFactIds.length > 0` for a fact-bearing trigger.
6. **Pre-launch sanity** — replay tail latency (mock mode) should be
   in the 50-200ms range per row, NOT the ~810ms cluster
   (R9.5a-locked 1500ms cap is far above; cluster suggests bug).
7. **Commit hygiene scan**: `git log -1 --format=%B` — confirm no
   `Co-Authored-By`, no emoji, no `.claude/` path. `git show --stat
   HEAD` — confirm no `.claude/` files committed.

**APPROVED requires**:

- 0 CRITICAL / 0 HIGH findings.
- AND smoke replay output shows ≥1 row with `matchedFactIds`
  non-empty.
- AND full vitest run passes with no NEW regressions.

If APPROVED, push the branch:
`git -C <worktree> push -u origin fix/replay-harness-wire-selflearning`
then open PR with `gh pr create --base main --head fix/replay-harness-wire-selflearning`
(per `feedback_gh_pr_create_explicit_base_head` standing rule).
**Do NOT merge autonomously** — open PR + wait for user per
`feedback_never_autonomous_merge_to_default_branch`.

---

## 8. Standing rules (verbatim — Developer briefing)

- ASCII single quotes only — NO smart quotes (would break tsc).
- No emojis. No `Co-Authored-By`. No `.claude/` paths in commits.
- Edge tests mandatory: T-1c (fail-open) AND T-2c (wired-but-empty-DB)
  are the SOUL edge tests.
- Conventional commits.
- Helpers normalize input internally.
- Validator at every boundary.
- Bot is groupmate not assistant.
- Metadata on result, no side-channel maps.
- Worktree-local script path discipline — Reviewer MUST run smoke
  command from worktree path, not master tree.
- After APPROVED: `git push -u origin <branch>` then `gh pr create
  --base main --head <branch>`. NEVER merge autonomously to master.

---

## 9. Hand-off to Developer (Task #53)

Developer should:

1. Apply the §1 diff to `scripts/eval/replay-runner-core.ts` exactly
   as specified — no creative deviations.
2. Create the two test files verbatim from §2 and §3 — no
   modifications to assertions or fixture-writer helpers.
3. Run `npx tsc --noEmit` from the worktree — fix any tsc error
   IMMEDIATELY before proceeding to test runs.
4. Run the 6 new tests — fix any failure in the test code only
   (NOT in `replay-runner-core.ts`); if a test failure points to a
   spec defect, SendMessage team-lead before workaround.
5. Run `npx vitest run` full suite — confirm no regressions.
6. ASCII quote scan + commit hygiene scan.
7. Single commit + push to origin (no PR open from Developer; that's
   Reviewer's call after APPROVED).
8. SendMessage team-lead with the commit SHA + brief delta summary.
