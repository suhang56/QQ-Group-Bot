# C-2 Replay Smoke — 2026-05-06

Branch: `feat/r9-c2-derivecjkterm`  
Commit: post-C-2 impl  
Mode: mock-LLM  
Fixture: `test/fixtures/replay-prod-db-synthetic-r9smoke.sqlite` + synthetic gold/benchmark (2 rows)

## Counts

- totalRows: 2
- errorRows: 0
- silenceDeferCompliance: 1.0 (1/1)
- resultKindDist: silent=2, reply=0

## hasRealFactHit analysis

hasRealFactHit 0->N on 2-row smoke: **0 shortform-shape rows in synthetic fixture**

The synthetic fixture benchmark contains only two rows (`今天天气真好`, `有人在吗`) — neither is a shortform-shape query. The r9smoke fixture DB has 0 meme_graph rows and 0 active learned_facts rows.

Therefore `hasRealFactHit` remains 0/2 in this smoke run — this is expected and correct: the smoke fixture was built before C-2 and does not exercise the shortform expansion path.

**Unit test coverage confirms the path works:** `test/extract-candidate-terms-shortform.test.ts` A1 test seeds a real `meme_graph` row (canonical=`羊宫妓那`, variants=`["ygfn"]`) and a real `learned_facts` row, then verifies `findActiveByTopicTerm(g1, '羊宫妓那')` returns >=1 row after `extractCandidateTerms('ygfn 是谁', 'g1', db.memeGraph)` expansion. This is the production code path, not a mock.

Production replay with `hasRealFactHit 0->N` confirmation requires a replay DB seeded with shortform meme_graph variants and matching learned_facts rows — scope of Phase 3 (R9 facts hydration).

## plannerSource / factSource sample

plannerSource=null for both rows (silent outcome, mock mode, no LLM invoked).
