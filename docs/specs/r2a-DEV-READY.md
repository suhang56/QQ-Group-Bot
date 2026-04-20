# DEV-READY: R2a — Timing Gate Frontload + `classifyPath` Pure Preview

## 0. Architect Q-resolutions (decisions from Designer handoff)

### Q1 — `_shouldRepeat` purity
**VERDICT: repeater is NOT pure preview. Ultra-light branch MUST NOT include repeater.**

- Designer cited `_shouldRepeat` at `src/core/router.ts:1268–1270` — this symbol does not exist. Actual function is `_checkRepeater` at `src/core/router.ts:1264`.
- Grep of `_checkRepeater` body (`src/core/router.ts:1264–1296`) shows:
  - `this.adapter.send(msg.groupId, content)` — line 1293 (side-effect, sends the echo)
  - `this.repeaterCooldown.set(key, Date.now())` — line 1291 (state mutation)
  - `this.logger.info(...)` — line 1294
- Additionally, `_checkRepeater` is **already called at line 582**, BEFORE line 634 (`isAtMention` computation) and BEFORE the `classifyPath` insertion point at line 680. It therefore runs INDEPENDENTLY of the timing gate and will return early (`return`) on match.
- **Consequence**: repeater is out-of-path w.r.t. R2a; `classifyPath` will never be reached when repeater fires. Do NOT list repeater as an ultra-light kind. Ultra-light = **relay only**.
- PLAN §3 edge case #6 ("burst + repeater → timing 不拦") is automatically satisfied because `_checkRepeater` returns & exits the handler before line 634. No R2a code change needed; just a test that asserts the unchanged ordering.

### Q2 — `classifyPath` module placement
**VERDICT: new file `src/core/classify-path.ts`** (separate module).

Rationale:
- `router.ts` is already 2900+ lines (verified: registrar spans 2166 → 2900+).
- Pure-fn + 100× snapshot purity test (M5) is materially easier when importable standalone (no Router instance construction for the unit test).
- Dep graph: imports only TypeScript types — no circular risk. `RelayDetection` from `../modules/relay-detector.js`; `GroupMessage` from `../adapter/napcat.js`; no Router import needed.
- Testability beats one import line.

### Q3 — mimic split
**VERDICT: Designer's recommendation stands.**
- `/mimic` slash command → `hard-bypass` (caught by command predicate — peekCmd ∈ commands).
- `mimic_on` active path (router.ts:630–665, calls `generateMimic()` async LLM): **timing-gated**. Not ultra-light (hits LLM).
- `mimic_on` lurker random-roll (line 641 `Math.random() < 0.3`): by the time R2a code is reached, `generateMimic()` is already in-flight or already returned; mimic_on active-user block runs BEFORE line 668 `this.chatModule` block. So classifyPath executes ONLY on the non-mimic fall-through — no split needed inside classifyPath. Edge case #7 maps to the mimic block returning early when `isAtMention` is true at 641, NOT to classifyPath logic.

---

## 1. File changes (exact list)

- `src/core/classify-path.ts` (**NEW**) — pure `classifyPath(ctx)` function + `PathKind` type + `ClassifyCtx` interface.
- `src/core/router.ts` (**MODIFY**) — splice classification + branching between line 675 (`} else {`) and line 680 (existing `let skipStickerFirst = ...`).
- `test/core/classify-path.test.ts` (**NEW**) — pure-fn unit tests (9 edge cases from PLAN §3 + 100× purity snapshot).
- `test/core/router-r2a-integration.test.ts` (**NEW**) — wiring test: burst + `@bot` reaches `_enqueueAtMention`, burst + plain chat reaches `evaluatePreGenerate`, burst + `/kick`-style admin cmd short-circuits at line 525 (pre-existing behavior, R2a regression guard).

**No changes**: schema.sql, engagement-decision.ts, relay-detector.ts.

---

## 2. TypeScript signatures

```typescript
// src/core/classify-path.ts
import type { RelayDetection } from '../modules/relay-detector.js';

export type PathKind = 'hard-bypass' | 'ultra-light' | 'timing-gated' | 'direct';

export interface ClassifyCtx {
  isAtMention: boolean;          // router.ts:634 — CQ:at match
  isReplyToBot: boolean;         // router.ts:636 — CQ:reply + bot in recentMsgs
  isSlashCommand: boolean;       // msg.content.trim().startsWith('/')
  commandIsRegistered: boolean;  // this.commands.has(peekCmd) — true for any slash cmd caller recognizes
  relay: RelayDetection | null;  // detectRelay(recentMsgs, botUserId) output — nullable
}

/**
 * Pure function. Zero side effects — no DB, no adapter, no cooldown mutation, no LLM.
 * Evaluation order is deterministic and priority-ordered:
 *   1. hard-bypass (slash command recognized)      — admin/mod actions
 *   2. direct (at-mention OR reply-to-bot)         — user explicitly addresses bot
 *   3. ultra-light (relay echo/vote/claim)         — cheap non-LLM participation
 *   4. timing-gated (fall-through)                 — organic chat, subject to evaluatePreGenerate
 *
 * Note: direct OUTRANKS ultra-light (a user who @s the bot in a relay deserves a direct reply).
 * Note: hard-bypass OUTRANKS direct (admin `/kick @bot` still kicks, not chats).
 */
export function classifyPath(ctx: ClassifyCtx): PathKind;
```

**Insertion inside router.ts** (around current line 675–679):

```typescript
// Existing at 668: if (this.chatModule) {
// Existing at 669–671: isAtMention computed
// Existing at 673: if (isAtMention) { await this._enqueueAtMention(msg, config); }
// Existing at 675: } else {
// ─── R2a SPLICE BEGIN (after line 675) ───
const isReplyToBot = !!this.botUserId
  && msg.rawContent.includes('[CQ:reply,')
  && recentMsgs.some(m => m.userId === this.botUserId);
const isSlashCommand = msg.content.trim().startsWith('/');
const commandIsRegistered = isSlashCommand
  && this.commands.has(msg.content.trim().slice(1).split(/\s+/)[0]?.toLowerCase() ?? '');
const relay = detectRelay(recentMsgs, this.botUserId ?? '');

const pathKind = classifyPath({ isAtMention, isReplyToBot, isSlashCommand, commandIsRegistered, relay });
this.logger.debug({ groupId: msg.groupId, userId: msg.userId, pathKind }, `path-classifier:${pathKind}`);

if (pathKind === 'hard-bypass') {
  // Pre-existing command dispatch already handled this at line 525–542; unreachable in practice,
  // but branch exists for defensive clarity. Return here to skip chat pipeline.
  return;
}
if (pathKind === 'direct') {
  // reply-to-bot goes through the same enqueue path as @-mention
  await this._enqueueAtMention(msg, config);
  return;
}
if (pathKind === 'ultra-light') {
  // relay path: skip sticker-first + timing gate, let chatModule handle it directly
  // (chatModule's own relay branch fires and sends the echo without LLM)
  await this.chatModule.handleMessage(msg, recentMsgs, config);
  return;
}
// pathKind === 'timing-gated': fall through to existing sticker-first + timing gate below
// ─── R2a SPLICE END ───

// Existing lines 680+ unchanged: skipStickerFirst, sticker-first block, evaluatePreGenerate block...
```

**Note on `isAtMention` branch (line 673)**: pre-existing `if (isAtMention)` already hard-paths to `_enqueueAtMention`. R2a does NOT modify that branch. `classifyPath` is reached only via the `else` (line 675) — so `ctx.isAtMention` will always be `false` when classifyPath is called through router. Tests still assert all 4 PathKind outputs because classifyPath is a pure unit that must stay correct if called with any input.

---

## 3. SQL queries

**None.** R2a is routing logic only. Grep-verified `schema.sql` untouched in PLAN scope. Verified: PLAN §2 explicitly excludes schema/migration work.

---

## 4. Integration points

### Imports inside `classify-path.ts`
- `type { RelayDetection } from '../modules/relay-detector.js'` (type-only — no runtime dep)

### New imports added to `router.ts`
- `import { classifyPath, type ClassifyCtx } from './classify-path.js';`
- `import { detectRelay } from '../modules/relay-detector.js';` — grep-verified: not currently imported in router.ts (it's imported in `src/modules/chat.ts:39`). R2a is first router.ts consumer. Non-circular.

### Call site
- `router.ts` line 675 → insertion point per §2 splice.
- Computed signals already local to the scope: `msg`, `recentMsgs` (line 619), `isAtMention` (line 669), `this.commands` (Map<string, Handler>), `this.botUserId`, `this.logger`.

### Test file placement
- `test/core/classify-path.test.ts` — pure-fn tests (follows `test/core/router-facts-pending.test.ts` existing pattern).
- `test/core/router-r2a-integration.test.ts` — router integration (mirrors `test/router-sticker-first.test.ts` mock adapter pattern).
- Vitest glob: `test/**/*.test.ts`; `test/integration/` EXCLUDED per `vitest.config.ts` — DO NOT place under integration/.

### Layer rule compliance
- `src/core/classify-path.ts` → `src/modules/relay-detector.ts` — **core → modules is forbidden** per ARCHITECTURE.md (adapter→core→modules→ai→storage).
- **Resolution**: import **type-only** (`import type { RelayDetection }`) — TypeScript strips type imports at emit, so runtime graph is clean. If reviewer enforces no cross-layer type imports either: inline `type RelayDetection = { kind: 'echo'|'vote'|'claim'; content: string; chainLength: number }` directly in `classify-path.ts` as a local structural type (shapes match; `detectRelay` return type is assignable).

### Migration
- **None.** No schema change.

---

## 5. Test contract (vitest)

### `test/core/classify-path.test.ts` — pure-fn edge cases

| # | PLAN case | Test assertion |
|---|---|---|
| 1 | burst + @bot | `classifyPath({ isAtMention: true, isReplyToBot: false, isSlashCommand: false, commandIsRegistered: false, relay: null })` → `'direct'` |
| 2 | burst + plain chat | `classifyPath({ isAtMention: false, isReplyToBot: false, isSlashCommand: false, commandIsRegistered: false, relay: null })` → `'timing-gated'` |
| 3 | burst + `/kick` (registered admin cmd) | `classifyPath({ ..., isSlashCommand: true, commandIsRegistered: true })` → `'hard-bypass'` |
| 4 | burst + `/bot_status` / `/persona_review` (DM-path, not in `this.commands`) | NON-splice. Test only asserts `isSlashCommand: true, commandIsRegistered: false` → `'timing-gated'` fall-through (DM path handled elsewhere at router.ts:1964; never reaches classifyPath in group context) |
| 5 | burst + relay echo | `classifyPath({ ..., relay: { kind: 'echo', content: '666', chainLength: 3 } })` → `'ultra-light'` |
| 6 | burst + repeater | N/A in classifyPath (repeater returns at line 582 before classifyPath reached). Covered by integration test, not unit. |
| 7 | LLM-backed mimic | N/A in classifyPath (mimic handled at lines 630–665 before classifyPath). Covered by integration test asserting mimic active → classifyPath not called. |
| 8 | reply-to-bot w/ non-empty quote | `classifyPath({ isAtMention: false, isReplyToBot: true, ... })` → `'direct'` |
| 9 | @bot + relay (priority) | `classifyPath({ isAtMention: true, relay: { kind: 'vote', ... } })` → `'direct'` (direct outranks ultra-light) |
| 10 | admin `/kick` + relay (priority) | `classifyPath({ isSlashCommand: true, commandIsRegistered: true, relay: {...} })` → `'hard-bypass'` |
| 11 | unknown `/ping` (not registered) | `classifyPath({ isSlashCommand: true, commandIsRegistered: false })` → `'timing-gated'` |

### Purity snapshot (M5)
```typescript
it('classifyPath is pure — 100x invocation does not mutate shared state', () => {
  const ctx: ClassifyCtx = { isAtMention: false, isReplyToBot: false, isSlashCommand: false, commandIsRegistered: false, relay: null };
  const adapterSend = vi.fn();
  const dbWrite = vi.fn();
  // classifyPath takes no Router/DB/adapter — purity proven by signature alone,
  // but assert invariance across calls AND zero spy invocation.
  const results: PathKind[] = [];
  for (let i = 0; i < 100; i++) results.push(classifyPath(ctx));
  expect(results.every(r => r === 'timing-gated')).toBe(true);
  expect(adapterSend).toHaveBeenCalledTimes(0);
  expect(dbWrite).toHaveBeenCalledTimes(0);
});
```

### `test/core/router-r2a-integration.test.ts`

Mirror `router-sticker-first.test.ts` adapter-mock pattern. Assertions:
- **burst + @bot** → `_enqueueAtMention` called; `deferQueue.enqueue` NOT called.
- **burst + plain chat** → `evaluatePreGenerate` reached; `deferQueue.enqueue` called (action='defer').
- **burst + registered slash cmd `/stats`** → command handler invoked; classifyPath never reached (pre-existing line 525 short-circuit).
- **burst + repeater match (3 identical recent msgs)** → `_checkRepeater` sends; classifyPath never reached.
- **relay echo (3 identical peer msgs length≤4)** → `chatModule.handleMessage` called without sticker-first interception and without `evaluatePreGenerate`.

---

## 6. Replay comparison runbook

R6.3 replay runner landed on master at SHA `0f28567` (PR #104). Grep-verified: `scripts/eval/replay-runner.ts` on this worktree; `gold-493.jsonl` cross-worktree at r6-label-work (gitignored by design); master baseline `METRICS.md` + `summary.json` cross-worktree at r6-3-replay (full paths in §8).

Flags (grep-verified `replay-cli-args.ts:18–66`): required `--gold --benchmark --output-dir --llm-mode mock --prod-db --bot-qq --group-id`; optional `--timeout-ms` (default 10000). Note: `--output-dir` NOT `--out`.

### Developer-run command (from r2a-timing-gate worktree root)
```bash
NODE_OPTIONS=--experimental-sqlite npx tsx scripts/eval/replay-runner.ts \
  --gold        D:/QQ-Group-Bot/.claude/worktrees/r6-label-work/data/eval/gold/gold-493.jsonl \
  --benchmark   D:/QQ-Group-Bot/.claude/worktrees/r6-label-work/data/eval/r6-label-input/benchmark-weak-labeled.jsonl \
  --output-dir  data/eval/replay/r2a-branch-$(git rev-parse --short HEAD)/ \
  --llm-mode    mock \
  --prod-db     D:/QQ-Group-Bot/data/bot.db \
  --bot-qq      1705075399 \
  --group-id    958751334 \
  --timeout-ms  10000
```

Exit 0 = success → `replay-output.jsonl` + `summary.json` written to `--output-dir`.

### Diff against master baseline (for PR body §M7)
```bash
# master baseline summary.json (cross-worktree ref):
cat D:/QQ-Group-Bot/.claude/worktrees/r6-3-replay/data/eval/replay/master-baseline-0f28567/summary.json
# r2a branch summary (local to this worktree):
cat data/eval/replay/r2a-branch-<sha>/summary.json
```

PR body MUST populate the metric table with both columns from these two `summary.json` files:

| Metric | master baseline (0f28567) | R2a branch |
|---|---|---|
| direct-at-silenced | 47/48 = 97.92% | **must be ≤ 10%** (M1) |
| silence_defer_compliance | 202/202 = 100% | **must be ≥ 95%** (M2) |
| mockClaudeCalls | 21/493 | reported |

### Reviewer independent re-run (per `feedback_controlled_pipeline_single_runner.md`)
If Dev's replay output lives in the repo, Reviewer consumes it and spot-checks (does NOT re-run) — owner-runner single-runner rule.
If Reviewer wants an independent verification run: same command as Developer, with `--output-dir data/eval/replay/r2a-reviewer-$(git rev-parse --short HEAD)/` — then `diff` against Dev's output.

---

## 7. Acceptance gate

### Developer must produce
- [ ] `npx tsc --noEmit` clean (raw last-10-lines pasted)
- [ ] `npx tsc -p tsconfig.scripts.json` clean
- [ ] `npx vitest run test/core/classify-path.test.ts test/core/router-r2a-integration.test.ts` — all pass (raw output pasted, not summarized — per `feedback_escalate_opus_on_dev_fabricated_tests.md`)
- [ ] `npx vitest run` full suite — zero new failures vs master
- [ ] Run replay command from §6 → paste `summary.json` contents (or raw `direct-at-silenced` / `silence_defer_compliance` / `mockClaudeCalls` values) into PR body
- [ ] PR body side-by-side metric table fully populated (both baseline + R2a branch columns)
- [ ] M1 direct-at-silenced ≤ 10%  /  M2 silence_defer_compliance ≥ 95% on R2a column

### Reviewer must independently
- [ ] `git log origin/r2a-timing-gate -1` — confirm latest SHA matches dev report
- [ ] Run `npx tsc --noEmit` + `npx tsc -p tsconfig.scripts.json` fresh
- [ ] Run `npx vitest run` fresh
- [ ] Read `src/core/classify-path.ts` top-to-bottom — confirm zero `this.`, zero `await`, zero `import { ... }` of adapter/db/logger
- [ ] Confirm router.ts splice respects line 673 `isAtMention` early-path (no double-enqueue)
- [ ] Replay evidence: spot-check Dev's `summary.json` matches PR body table; OR run independent replay per §6 and diff vs Dev's output (Reviewer's call per `feedback_controlled_pipeline_single_runner.md` — consume-first, re-run only if warranted)

### Pipeline blocker
Reviewer APPROVED + zero MEDIUM/LOW findings unresolved (per `feedback_qqbot_fix_all_reviewer_findings.md`) + replay evidence pasted in PR body → auto-merge authorized per `feedback_qqbot_auto_merge_2026_04_19.md`.

---

## 8. Grep-verified symbols

| Symbol | File:line | Verified |
|---|---|---|
| `peekCmd` | `src/core/router.ts:523` | ✓ |
| `this.commands.has` / `this.commands.get` | `router.ts:537` | ✓ |
| `_registerCommands` | `router.ts:2166` | ✓ |
| `this.commands.set('rule_add')` | `router.ts:2500` | ✓ |
| `this.commands.set('fact_approve_all')` | `router.ts:2782` | ✓ |
| `this.commands.set('stickerfirst_on')` | `router.ts:2825` | ✓ |
| `this.commands.set('sticker_ban')` | `router.ts:2880` | ✓ |
| `_checkRepeater` (NOT `_shouldRepeat`) | `router.ts:1264` | ✓ NOT PURE |
| repeater `this.adapter.send` | `router.ts:1293` | ✓ side-effect |
| `this.repeaterCooldown.set` | `router.ts:1291` | ✓ mutation |
| `detectRelay` definition | `src/modules/relay-detector.ts:36` | ✓ pure (no this./import of side-effect mods) |
| `isAtMention` compute (mimic block) | `router.ts:634` | ✓ |
| `isReplyToBot` compute (mimic block) | `router.ts:636` | ✓ |
| `isAtMention` compute (chat block) | `router.ts:669` | ✓ |
| chat block `if (isAtMention)` → `_enqueueAtMention` | `router.ts:673–674` | ✓ |
| `else {` chat block | `router.ts:675` | ✓ insertion point |
| `let skipStickerFirst` | `router.ts:680` | ✓ splice target |
| `evaluatePreGenerate` call site | `router.ts:724` | ✓ (cited 719 by Designer — off by 5) |
| `evaluatePreGenerate` def | `src/modules/engagement-decision.ts:277` | ✓ |
| `this.deferQueue.enqueue` | `router.ts:734` | ✓ |
| `/bot_status` DM handler | `router.ts:1964` | ✓ NOT in `this.commands` map (admin DM path) |
| `/persona_review` | `router.ts:1826` | ✓ NOT in `this.commands.set` — DM-only |
| `scripts/eval/replay-runner.ts` | `.claude/worktrees/r2a-timing-gate/scripts/eval/replay-runner.ts` | ✓ (R6.3 PR #104 at SHA 0f28567) |
| `scripts/eval/replay-cli-args.ts` flag parser | `replay-cli-args.ts:18–66` | ✓ flag names verified |
| `gold-493.jsonl` | `.claude/worktrees/r6-label-work/data/eval/gold/gold-493.jsonl` | ✓ cross-worktree gitignored by design |
| master baseline `METRICS.md` | `.claude/worktrees/r6-3-replay/data/eval/replay/master-baseline-0f28567/METRICS.md` | ✓ cross-worktree |

Line count: ~290.
