# R9.5 prompt-only DESIGN

## §1. Decision rationale (split-ship)

`feat/r9-5-revival` 3fb4793 含 prompt addition + hydration 两块,Reviewer REVISE 后 team-lead "水管 C1 诊断" 证据:

| Signal | Value | Implication |
|---|---|---|
| `hasRealFactHit=true` rows | 0/781 | retrieval 在 benchmark 完全没 hit |
| `requiredFactCount=0` rows | 112/112 | Planner 永远 emit 不出 fact ids |
| llm-planner `directiveMode=reply, lengthBudget=normal` rows | 109/109 | prompt addition working as designed |
| Hydration block fire count | 0/781 | structurally unfireable |
| Reviewer-sampled fact-needed-no-fact rows with substantive groupmate-attempt | 8/25 (32%) | prompt qualitative win |

**Conclusion**: prompt addition 真有作用,hydration 是 dead branch。按 user directive(`别把死代码混进 master`),split-ship prompt-only。

## §2. What this PR keeps from 3fb4793

```
src/modules/reply-planner.ts:485  const → export const  (bare re-export)
src/modules/reply-planner.ts:508  insert new bullet (verbatim from R9.5 revival DESIGN §1.2)
test/reply-planner-r9-5-revival-prompt.test.ts  T-9a/b/c/d 4 prompt-pin assertions
```

总 LOC: src +2/-1, test +32/0。

## §3. What this PR drops from 3fb4793

```
src/storage/db.ts          findByIds interface + impl (+17 LOC)
src/modules/self-learning.ts  getFactsByIds wrapper (+49 LOC)
src/modules/chat.ts        hydration block (+14/-5 LOC)
test/self-learning-getFactsByIds.test.ts        (NEW +136)
test/chat-r9-5-revival-hydration.test.ts        (NEW +285)
```

总撤 LOC: ~+501/-5。这些代码 well-tested isolation but cannot fire on benchmark per C1 evidence。Park as future R9.5b/R9.6.0 PR after retrieval rebuild work lands。

## §4. New bullet wording (verbatim,unchanged from R9.5 revival DESIGN §1.2)

ASCII single quote outer delimiter,CJK content,no smart quotes,fullwidth punctuation 是 prompt 里允许的(per Designer §1 Q1 wording lock):

```
'- 当 has_real_fact_hit=false 且 trigger 是问句（含 ?/？/谁/啥/什么/吗/呢 等）且 is_at=true 或 is_reply_to_bot=true → mode=reply，length_budget=normal。群友被点名问问题时不会一字带过；要么猜一下、要么反问回去、要么说不知道但带上下文，正经接一句即使没事实命中。',
```

设计原则(per `feedback_no_reverse_priming_in_prompt`):
- **不 enumerate banned strings**(73999cb 早期版本含 `'嗯？'/'啥'` 反锚定,Designer 已移除)
- 用 abstract category("问句"+"is_at|is_reply_to_bot")pair-with-paired-rule(对称 `has_real_fact_hit=true → fact_answer`)
- positive guidance("猜一下/反问/说不知道但带上下文")not negative("不要 X")

## §5. Position decision (post-`has_real_fact_hit=true` bullet)

reply-planner.ts:507-508 之间插入。新 bullet 紧跟 `has_real_fact_hit=true → fact_answer`,形成 has-hit/no-hit 对称对:

```
- 当 has_real_fact_hit=true 且 trigger 是问句 → mode=fact_answer，required_fact_ids 至少 1 个
- 当 has_real_fact_hit=false 且 trigger 是问句（含 ?/？/谁/啥/什么/吗/呢 等）且 is_at=true 或 is_reply_to_bot=true → mode=reply，length_budget=normal。... ← NEW
- 当 is_at=false 且 utterance_act==chime_in 且 d_non_bot >= 2 → 倾向 mode=silent 或 ack
```

LLM 更容易 follow 对称 rule。

## §6. Test matrix (unchanged from 3fb4793)

T-9a string-contains `'has_real_fact_hit=false'` + `'mode=reply'`
T-9b string-contains `'length_budget=normal'`(not tiny/short)
T-9c bullet count under `约束：` block goes 6 → 7
T-9d position assertion(new bullet appears after `has_real_fact_hit=true` bullet)

均为 deterministic string assertions on `R9_PLANNER_SYSTEM_PROMPT`,不需要 LLM 调用。

## §7. Acceptance(per PLAN §4)

- tsc 0 errors
- 4/4 prompt-pin tests pass
- Full vitest no new regressions vs master `9e5a894`
- ASCII quote scan empty
- No `.claude/` paths in commit, no Co-Authored-By
- Single conventional commit per PLAN §9

NOT this PR's gate:
- `fact-needed-no-fact` count(retrieval-coverage,not reply-quality)
- hydration behavior(scope OUT)
- 781-row real-LLM replay(已在 R9.5 revival 复用证据)

## §8. Standing rules(embed verbatim)

[same block as PLAN §10]
