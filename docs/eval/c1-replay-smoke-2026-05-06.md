# C-1 Replay Smoke — 2026-05-06

Branch: `feat/r9-c1-fts5-tokenize`  
Date: 2026-05-06  
Mode: mock-LLM + in-memory FTS5 fixture (trigram tokenizer)  
Rows sampled: 8 (all A3 question-shape edge cases; ≤30 per PLAN A9)

## Summary

| metric | pre-fix | post-fix |
|---|---|---|
| totalQuestionShapeRows | 8 | 8 |
| hasRealFactHit | 0 | 8 |
| delta | — | 0 → 8 |

**A9 criterion met:** `hasRealFactHit` went from 0 (all 8 question-shape rows miss) to 8 (all 8 hit).

## Method

Direct FTS5 MATCH test on in-memory DB with trigram tokenizer (same schema as prod: `src/storage/schema.sql`).  
Pre-fix behavior: legacy `sanitizeFtsQuery` wraps entire question string as phrase-literal (e.g. `"高松灯是谁"`).  
Post-fix behavior: new `sanitizeFtsQuery` strips CN tail, wraps stripped term (e.g. `"高松灯"`).

Fact fixture: 4 rows (高松灯/千早爱音/live/户山香澄), matching DESIGN §7 minimum spec.

## Per-row counts

| preFixQuery | preFixHits | postFixQuery | postFixHits | factSource | retrievedTermKey |
|---|---|---|---|---|---|
| `"高松灯是谁"` | 0 | `"高松灯"` | 1 | 角色:高松灯 | `"高松灯"` |
| `"高松灯是什么"` | 0 | `"高松灯"` | 1 | 角色:高松灯 | `"高松灯"` |
| `"高松灯是哪个"` | 0 | `"高松灯"` | 1 | 角色:高松灯 | `"高松灯"` |
| `"高松灯谁啊"` | 0 | `"高松灯"` | 1 | 角色:高松灯 | `"高松灯"` |
| `"高松灯是谁啊"` | 0 | `"高松灯"` | 1 | 角色:高松灯 | `"高松灯"` |
| `"高松灯是谁？"` | 0 | `"高松灯"` | 1 | 角色:高松灯 | `"高松灯"` |
| `"这个高松灯是谁"` | 0 | `"高松灯"` | 1 | 角色:高松灯 | `"高松灯"` |
| `"那啥高松灯"` | 0 | `"高松灯"` | 1 | 角色:高松灯 | `"高松灯"` |

plannerSource: mock-mode-n/a (no LLM calls in smoke; retrieval layer verified independently)

## Verification

- `tsc --noEmit`: exit 0
- `npx vitest run test/text-tokenize.test.ts`: 63/63 passed
- `npx vitest run` (full suite): 5347 passed; 20 failed in pre-existing integration tests (Claude API overloaded, unrelated to text-tokenize.ts)
- Sentinel suites: bm25-search, path-a-ondemand, chat-ondemand-weak-leak, chat-rules-sanitize, chat-sticker-hints-sanitize — all 5 passed (46 tests total)
