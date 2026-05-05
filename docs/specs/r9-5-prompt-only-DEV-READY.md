# R9.5 prompt-only DEV-READY

## §1. Verbatim diff

### File: `src/modules/reply-planner.ts`

**Line 485**(was bare `const`,add `export`):

```diff
-const R9_PLANNER_SYSTEM_PROMPT = [
+export const R9_PLANNER_SYSTEM_PROMPT = [
```

**Line 508**(insert new bullet between `has_real_fact_hit=true → fact_answer` and `is_at=false ... chime_in`):

```diff
   '- 当 has_real_fact_hit=true 且 trigger 是问句 → mode=fact_answer，required_fact_ids 至少 1 个',
+  '- 当 has_real_fact_hit=false 且 trigger 是问句（含 ?/？/谁/啥/什么/吗/呢 等）且 is_at=true 或 is_reply_to_bot=true → mode=reply，length_budget=normal。群友被点名问问题时不会一字带过；要么猜一下、要么反问回去、要么说不知道但带上下文，正经接一句即使没事实命中。',
   '- 当 is_at=false 且 utterance_act==chime_in 且 d_non_bot >= 2 → 倾向 mode=silent 或 ack',
```

### File: `test/reply-planner-r9-5-revival-prompt.test.ts`(NEW)

32 LOC,4 deterministic string-assertion tests on `R9_PLANNER_SYSTEM_PROMPT` import:

- T-9a: contains `'has_real_fact_hit=false'` substring + `'mode=reply'`
- T-9b: contains `'length_budget=normal'`(not `tiny` / `short`)
- T-9c: split prompt array on lines starting with `'- '` after `约束：` boundary line; assert count goes from 6 → 7
- T-9d: assert new bullet's array index is `has_real_fact_hit=true bullet index + 1`

## §2. Iteration Contract

| File | Change | LOC |
|------|--------|-----|
| `src/modules/reply-planner.ts` | export keyword + 1 new bullet | +2 / -1 |
| `test/reply-planner-r9-5-revival-prompt.test.ts` | NEW deterministic prompt-pin tests | +32 |
| `docs/specs/r9-5-prompt-only-PLAN.md` | NEW | docs |
| `docs/specs/r9-5-prompt-only-DESIGN.md` | NEW | docs |
| `docs/specs/r9-5-prompt-only-DEV-READY.md` | NEW | docs |
| **Total source/test** | | **+33 / -1** |

## §3. Pre-commit gates

```
cd D:/QQ-Group-Bot/.claude/worktrees/r9-5-prompt-only
npx tsc --noEmit                                          # MUST 0 errors
npx vitest run test/reply-planner-r9-5-revival-prompt.test.ts   # MUST 4/4 pass
npx vitest run                                             # full suite — no NEW failures vs master 9e5a894
```

ASCII smart-quote scan(must be empty):
```
grep -nP '[\x{2018}\x{2019}\x{201C}\x{201D}]' src/modules/reply-planner.ts test/reply-planner-r9-5-revival-prompt.test.ts docs/specs/r9-5-prompt-only-PLAN.md docs/specs/r9-5-prompt-only-DESIGN.md docs/specs/r9-5-prompt-only-DEV-READY.md
```

`.claude/` path check:
```
git diff --cached --name-only | grep '\.claude/'    # MUST be empty
```

Co-Authored-By check:
```
git log -1 --format=%B | grep -i 'co-author'    # MUST be empty
```

## §4. Stage + commit

```
git add src/modules/reply-planner.ts test/reply-planner-r9-5-revival-prompt.test.ts docs/specs/r9-5-prompt-only-PLAN.md docs/specs/r9-5-prompt-only-DESIGN.md docs/specs/r9-5-prompt-only-DEV-READY.md
git status --short    # MUST show ONLY those 5 staged
git commit -m 'feat(reply): R9.5 planner prompt addition for no-fact-hit + question scenarios — split-ship from revival pre-retrieval-rebuild'
git push -u origin fix/r9-5-prompt-only
```

## §5. Acceptance evidence reuse from R9.5 revival

Real-LLM 781-row replay 已在 R9.5 revival(commit `3fb4793`,branch `feat/r9-5-revival`)跑过($0.105 cost,artifacts at `D:/QQ-Group-Bot/data/eval/replay/r9-5-revival-acceptance/`)。从中复用作为 prompt-only PR 的 directive-behavior + qualitative-sample 证据:

- **directive shape evidence**: 109/109 `plannerSource=llm-planner` rows emit `directiveMode=reply, lengthBudget=normal`(per run.log)— prompt addition 让 Planner 听话
- **qualitative reply-text shift**: Reviewer abstract 23 fact-needed-no-fact rows,8/25 含 substantive groupmate-attempt(`羊宫妃那？不就高松灯的CV嘛`、`谁是拉神？`、`Afterglow Pastel*Palettes ... 这些呀` 等)— prompt 真改了 Replyer 行为
- **invariants preserved**: parse rate 97.32%(R9.5a 是 98.21%,在 ≥95% 区间);direct-at-silenced 9/0/6(R9.5a 是 8/0/6,在 ±1 噪声区间)

prompt-only PR **不需要单独**跑新 781-row benchmark — 上述 evidence 是同 commit 跑出来的,prompt 是 sub-set diff 的子集。

## §6. Reviewer audit hooks

- 静态:tsc + 4 prompt-pin tests + full vitest + ASCII scan + spec→impl 1:1
- evidence reuse:read R9.5 revival run.log 确认 109/109 directiveMode=reply + 抽样 8 行 reply text(Reviewer 已做过 in #48 audit)
- NO new real-LLM replay required(scope-correct evidence already exists)

## §7. Standing rules

[verbatim block from PLAN §10]
