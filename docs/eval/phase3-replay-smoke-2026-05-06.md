# Phase 3 Replay Smoke — 2026-05-06

Branch: feat/r9-planner-facts-input-hydration
Runner: scripts/replay-r9-facts.ts (worktree-local)
Mode: in-memory DB, mock LLM, real SelfLearningModule + ReplyPlanner spy
Fixture: 3 learned_facts rows + 1 meme_graph row (see DESIGN.md §6)

## A9 Criterion

Pre-Phase-3: plannerFactCount=0 on ALL 3 rows (facts:[] hardcode in chat.ts)
Post-Phase-3: plannerFactCount>=1 on ALL 3 rows (Phase 3 wiring active)

Result: PASS (3/3 flip)

## Per-row counts

### Pre-Phase-3 baseline (chat.ts stashed to d8eb062)

| triggerText | hasRealFactHit | plannerFactCount |
|---|---|---|
| ygfn 是谁 | true | 0 |
| 羊宫妃那是谁 | true | 0 |
| 高松灯是谁 | true | 0 |

### Post-Phase-3 (Phase 3 Hunk A + B applied)

| triggerText | hasRealFactHit | plannerFactCount | sample factId | sample term | sample meaning |
|---|---|---|---|---|---|
| ygfn 是谁 | true | 2 | 1 | user-taught:ygfn | ygfn是羊宫妃那啊 |
| 羊宫妃那是谁 | true | 2 | 2 | user-taught:ygfn | ygfn是羊宫妃那啊 |
| 高松灯是谁 | true | 1 | 3 | 高松灯 | 高松灯是Tsukinomori成员之一 |

## Notes

- plannerFactCount=2 on ygfn rows: both the ygfn canonicalForm row (id=1) and
  the 羊宫妃那 canonicalForm row (id=2) share the same topic/fact and both fire
  via pre-pass → both appear in matchedFacts → both passed to PlannerContext.facts.
  This is correct behavior (cap=8, both rows are retrieval hits). Planner sees both.
- 高松灯 plannerFactCount=1: single row, correct.
- hasRealFactHit=true on all pre-Phase-3 rows confirms Phase 2 retrieval (C-1/C-2/C-3)
  fired correctly before Phase 3 wiring. Phase 3 closes the hydration loop.
- No PII in this document — counts only, in-memory fixture.
