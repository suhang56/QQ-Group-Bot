# R9.5 prompt-only — split-ship from R9.5 revival

## 1. Why this is a split

R9.5 revival(branch `feat/r9-5-revival` commit `3fb4793`,unmerged)按 PLAN §1.2 锁定 PRIMARY=2 个 work block:**prompt addition** + **factsByIdMap hydration**。Reviewer 跑 real-LLM 781-row replay 后判 REVISE,team-lead 做"水管诊断"(C1 决策树),证据决定性:

```
chat timing (planner) 总条数: 112
  llm-planner:    109,requiredFactCount=0  → 100% 全空
  rule-fallback:    3,requiredFactCount=0  → 100% 全空
hasRealFactHit=true: 0/781  → benchmark 上 fact retrieval 完全没 surface
```

**根因**: hydration block fire 条件是 `directive.requiredFactIds.length > 0`,但 Planner 的 `available_fact_ids` 永远是空集(因 retrieval 在 benchmark 0 hit + validator strip Planner 编造的 ids per Designer §1.3)。所以 hydration block 在 **781/781 行结构性 unfireable**。这是 R9.5 revival PLAN §1.3 锁出 retrieval scope 的直接后果。

**结论**: hydration 是死代码状态(永远不 fire),不该 ship master。Prompt addition **真有 qualitative 收益**(Reviewer 抽样 8/25 fact-needed-no-fact 行确认 reply 从 short shrug 翻到 substantive groupmate-attempt),即使 metric 不能 capture。

按 user 决定的 path 2: **prompt-only ship,撤掉 hydration**。

## 2. Scope IN

唯一两个改动:

1. `src/modules/reply-planner.ts:485` — `R9_PLANNER_SYSTEM_PROMPT` 加 `export` keyword(让 prompt-pin test 能 import)
2. `src/modules/reply-planner.ts:508` — 在约束 list 第 2-3 bullet 间插入新 bullet(对称已有的 `has_real_fact_hit=true → fact_answer` rule):

   ```
   - 当 has_real_fact_hit=false 且 trigger 是问句（含 ?/？/谁/啥/什么/吗/呢 等）且 is_at=true 或 is_reply_to_bot=true → mode=reply，length_budget=normal。群友被点名问问题时不会一字带过；要么猜一下、要么反问回去、要么说不知道但带上下文，正经接一句即使没事实命中。
   ```

3. `test/reply-planner-r9-5-revival-prompt.test.ts` — 4 个 prompt-pin assertions(string-contains + bullet count + position + groupmate-tone keywords)

## 3. Scope OUT(撤自 R9.5 revival 3fb4793)

Hydration 全部撤:

- `src/storage/db.ts findByIds` 接口 + impl
- `src/modules/self-learning.ts getFactsByIds` wrapper
- `src/modules/chat.ts` hydration block(stale empty-Map decl 不 DELETE,等未来 input-side hydration PR 来 cleanup)
- `test/self-learning-getFactsByIds.test.ts`
- `test/chat-r9-5-revival-hydration.test.ts`

理由(C1 诊断证据):上述模块结构性 unfireable on benchmark — Planner emit 不出 requiredFactIds,因为上游 retrieval 没 surface facts。这些代码会变成死分支,违反 user 的 "别把死代码混进 master" directive。

## 4. Acceptance(改自 R9.5 revival)

R9.5 revival PRIMARY GATE 是 `fact-needed-no-fact ≤ ~17`。**这条对 prompt-only PR 不适用** — `fact-needed-no-fact` 是 retrieval-coverage 指标(`factNeeded=true && matchedFactIds=[]`),无关 prompt 行为。

prompt-only acceptance:

- **PRIMARY**: prompt addition 让 Planner 在 `has_real_fact_hit=false + question + is_at=true|is_reply_to_bot=true` scenarios 输出 `mode=reply, length_budget=normal`(不是 ack/silent/tiny)
- **EVIDENCE(已收集 from R9.5 revival replay)**:
  - 109/109 llm-planner directives 都是 `directiveMode=reply, lengthBudget=normal`(R9.5 revival run.log)
  - 8/25 fact-needed-no-fact 行 reply text 翻到 substantive groupmate-attempt(Reviewer 已抽样确认):`羊宫妃那？不就高松灯的CV嘛`、`谁是拉神？`、`Afterglow Pastel*Palettes ... 这些呀` 等
- **INVARIANTS**:
  - tsc 0 errors
  - 4 prompt-pin tests pass
  - Full vitest no new regressions vs master `9e5a894`
  - Parse rate ≥ 95%(R9.5a 已锁,prompt-only 不动 parse path)
  - Cluster wins preserved(R9.5 revival 已观察:direct-at-silenced 9 / by-abuse 0 / by-guard 6,在 R9.5a 的 8/0/6 ±1 区间)
- **EXPLICITLY NOT THIS PR'S GATE**:
  - `fact-needed-no-fact` count(retrieval-coverage 指标,无法用 prompt 改)
  - hydration behavior(scope OUT)

## 5. 不再做 real-LLM benchmark for primary gate

R9.5 revival 那次 781-row real-LLM replay($0.105)已经 generate 了 prompt-only 该看的全部 evidence:

- run.log 显示 109/109 llm-planner 出 `mode=reply, length=normal`
- replay-output.jsonl 显示 8/25 fact-needed-no-fact rows 含 substantive groupmate replies

prompt-only PR 不再单独跑 781-row benchmark(redundant + cost)。Reviewer 复用 R9.5 revival run 的 evidence。如果有 doubts,~$0.10 的 second run 可独立做。

## 6. Out-of-scope locks(verbatim from R9.5 revival)

- NO retrieval / alias work
- NO R9 gate change
- NO canary flag change
- NO parser change(R9.5a 已 ship)
- NO chat.ts hydration block(R9.5b candidate,见 §7)
- NO db.ts/self-learning.ts changes

## 7. Follow-up(NOT this PR)

`R9 planner facts input hydration`(provisional name: R9.5b 或 R9.6.0):

- 把 retrieval 输出(matchedFactIds + 它们的 term/meaning)填进 `PlannerContext.facts`(chat.ts:3191 当前硬编码 `[]`)
- 这才是让 hydration block fire 的前提
- 是 input-side hydration,不是 R9.5 revival 试做的 output-side hydration
- Designer 该 audit:为什么 benchmark 上 hasRealFactHit=0/781?retrieval 在所有 781 行都 miss,这是 retrieval 自身问题还是 fixture 问题
- 如果是 retrieval 问题,可能要先做 R9 retrieval rebuild work(项目 plan curried-wondering-rocket.md:207)
- R9.6 canary 和 input-side hydration 都 gated on 这个

## 8. Files

| File | Status | Size |
|------|--------|------|
| `src/modules/reply-planner.ts` | EDIT(+2 / -1) | export + bullet |
| `test/reply-planner-r9-5-revival-prompt.test.ts` | NEW(+32) | 4 prompt-pin assertions |
| `docs/specs/r9-5-prompt-only-PLAN.md` | NEW | this file |
| `docs/specs/r9-5-prompt-only-DESIGN.md` | NEW | rationale + scope split |
| `docs/specs/r9-5-prompt-only-DEV-READY.md` | NEW | verbatim diff + acceptance |
| `docs/eval/r9-5-revival-c1-diagnostic.md` | NEW(this PR) | hydration 0-fire diagnostic evidence |

## 9. Commit

Single commit: `feat(reply): R9.5 planner prompt addition for no-fact-hit + question scenarios — split-ship from revival pre-retrieval-rebuild`

No Co-Authored-By,no `.claude/` paths,ASCII single quotes only,no emojis。

## 10. Standing rules(embed verbatim)

- ASCII single quotes only
- No emojis. No Co-Authored-By. No `.claude/` paths in commits.
- Edge tests mandatory
- Conventional commits
- Helpers normalize input internally
- Validator at every boundary
- Bot is groupmate not assistant
- Metadata on result, no side-channel maps
- 不要 reverse priming(prompt bullet 没 enumerate banned strings,Designer 已 abstract 化 from 73999cb)
- 别把死代码混进 master(user directive 2026-05-05)
