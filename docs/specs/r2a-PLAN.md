# Feature: R2a — Timing Gate 前置 + Pure Bypass Preview

## Why

**北极星判据**: 群友收到 @bot 时会立刻回应,不会因为群里最近很活跃就沉默。Bot 现在不像群友,像一个会假装看不见直接 @ 的 AI assistant。

**R6.3 baseline audit (master 0f28567 / 06b55a9)**:
- `direct-at-silenced`: **97.92% (47/48)** — 几乎所有 direct @ 都被 timing gate 拦掉了
- `silence_defer_compliance`: 100% (202/202) — bot 很乖,但乖得太过,把真 direct 也 defer 了
- `mockClaudeCalls`: 21/493 — 95% 的样本在 timing gate 就短路(直接 silent),从未到达 LLM

**根因** (plan `curried-wondering-rocket.md` §R2a, audit finding #3): `router.ts:695–717` 非 direct 路径先跑 `sticker-first` 再走 timing gate,导致所有 direct 路径也被 timing gate 截断。Fix: timing gate 必须在 sticker-first / proactive chat 之前,direct path 直接绕过。

---

## Scope (in)

1. **非 direct 路径**:timing gate 移到 sticker-first / proactive chat 之前
2. **Hard-bypass** (admin / moderation / command): 复用现有 command registry pure predicate → 跳过 timing gate(不跳权限检查)
3. **Ultra-light** (relay / repeater): timing 不拦;relay/repeater 自身 cooldown 仍由各自 module 管理
4. **Direct override** (@bot / reply-to-bot): 跳过 timing gate
5. **`_classifyPath` pure preview**: 纯函数,零 DB write / cooldown write / send / LLM / state mutation

---

## Out of scope

- Rate-limit defer → **R2c**
- Defer recheck thread-continuous target / direct cancel / re-enqueue → **R2b**
- StrategyDecision / UtteranceAct 层 → **R4-lite**
- Prompt 分层 → **R5**
- FTS malformed fix → 独立 ticket

---

## Acceptance criteria

- [ ] **M1** `direct-at-silenced` ≤ 10% (baseline 97.92% → 修复目标)
- [ ] **M2** `silence_defer_compliance` ≥ 95% (baseline 100%, 不得大幅回退)
- [ ] **M3** `tsc --noEmit` + `tsc -p tsconfig.scripts.json` clean (零 error)
- [ ] **M4** All vitest pass (220 prior baseline + N new R2a tests)
- [ ] **M5** `_classifyPath` pure preview 副作用审计: 100x 调用 snapshot 前后 state/cooldown/counter 不变
- [ ] **M6** src/ 改动仅限 router + engagement decision touch points (no new module outside scope)
- [ ] **M7** PR body 包含 side-by-side `summary.json` diff: master baseline vs R2a branch (direct-at-silenced / compliance / mockClaudeCalls)

---

## Edge Cases to Test

1. **burst + @bot** → direct override proceeds (timing gate skipped, LLM called)
2. **burst + 普通闲聊** → timing gate defers (compliance maintained)
3. **burst + admin `/kick`** → hard-bypass proceeds (command registry predicate hit)
4. **burst + `/bot_status` / `/persona_review`** → hard-bypass proceeds (extended command list)
5. **burst + relay 第4条** → timing 不拦; relay own cooldown still respected (not overridden)
6. **burst + repeater** → timing 不拦; repeater own cooldown still respected
7. **LLM-backed mimic** → timing-gated (not ultra-light, goes through evaluatePreGenerate)
8. **`_classifyPath` 100x empty/varied invocation** → state unchanged (no DB write, no cooldown update, no send)
9. **reply-to-bot with non-empty quote** → direct override proceeds

---

## Replay Comparison Harness

Verification tool: `scripts/eval/replay-runner.ts` on master branch against `data/eval/gold-493.jsonl`.

PR body must include side-by-side diff of `summary.json`:

| Metric | master baseline (06b55a9) | R2a branch |
|---|---|---|
| direct-at-silenced | 47/48 = 97.92% | ≤ 10% |
| silence_defer_compliance | 202/202 = 100% | ≥ 95% |
| mockClaudeCalls | 21/493 | [reported] |

Run: `npx ts-node scripts/eval/replay-runner.ts --gold data/eval/gold-493.jsonl --out data/eval/replay/r2a-branch/`

---

## Open Questions for Designer / Architect

1. **`_classifyPath` 位置**: 新纯函数放 `router.ts` 内 vs 抽出独立模块 `src/core/path-classifier.ts`? 权衡:内联减文件数,独立模块更易测 pure-fn snapshot
2. **Direct override signal**: 复用现有 `isDirect` / `isAtBot` flags(已在 router context 计算) vs 在 `_classifyPath` 内重新计算? 需 Architect grep 确认这些 flags 在 timing gate 之前已经存在
3. **Hard-bypass command predicate API**: 现有 command registry 有无 exported pure predicate (e.g. `isAdminCommandLike()` / `isModeratorAction()`)? Architect 必须 grep `src/` 验证接口,不能假想
4. **Ultra-light: relay vs repeater 判断入口**: `relayDetector.detectPreview` 是否已是 pure fn(无副作用)? Architect 审计副作用
5. **Mimic audit scope**: `_classifyPath` 中如何区分 "纯本地 no-LLM mimic" vs "LLM-backed mimic"? 需 Architect grep mimic 实现入口
