# R6.3 Master Baseline — Commit 0f28567

Generated: 2026-04-20
Runner version: r6.3.0
LLM mode: mock
Gold: `gold-493.jsonl` (493 rows)
Benchmark: `benchmark-weak-labeled.jsonl`

## Headline Metrics

| Metric | Value |
|---|---|
| Total rows | 493 |
| Error rows | 0 |
| Wall-clock | 1.7s |
| Mock Claude calls | 21 |
| silence_defer_compliance | 202 / 202 = **100%** |

## Top Violation Tags (by count)

| Rank | Tag | Hits | Denominator | Rate |
|---|---|---|---|---|
| 1 | direct-at-silenced | 47 | 48 | 97.92% |
| 2 | gold-silent-but-replied | 0 | 100 | 0% |
| 3 | gold-defer-but-replied | 0 | 102 | 0% |

All other violation tags: 0 hits.

## Result Kind Distribution

| Kind | Count |
|---|---|
| silent | 492 |
| reply | 1 |
| sticker | 0 |
| fallback | 0 |
| defer | 0 |
| error | 0 |

## Reason Code Distribution

| Reason | Count |
|---|---|
| timing | 492 |
| engaged | 1 |

## Guard Path Distribution

| Path | Count |
|---|---|
| none | 493 |

## Per-Category Compliance

| Cat | Label | Rows | silence/defer denom | compliant | rate |
|---|---|---|---|---|---|
| 1 | direct_at_bot | 48 | 1 | 1 | 100% |
| 2 | known_fact_term | 48 | 30 | 30 | 100% |
| 3 | rhetorical_banter | 50 | 22 | 22 | 100% |
| 4 | image_mface | 50 | 50 | 50 | 100% |
| 5 | bot_status_context | 50 | 11 | 11 | 100% |
| 6 | burst_nondirect | 50 | 25 | 25 | 100% |
| 7 | relay | 47 | 5 | 5 | 100% |
| 8 | conflict_heat | 50 | 16 | 16 | 100% |
| 9 | normal_chimein | 50 | 19 | 19 | 100% |
| 10 | silence_candidate | 50 | 23 | 23 | 100% |

## Act Confusion Matrix (goldAct → utteranceActDist)

Every gold act except one `direct_chat` (→ `unknown`) maps to `none` in mock mode — the rate limiter returns silent before act classification runs, so `utteranceActDist` is dominated by `none: 492`. This is expected behavior at baseline (master-before-R2/R4/R5 work) and serves as the reference against which act-classification branches will diff.

## Notes

- Only 1 reply fired across all 493 rows (engaged/direct-at-bot path); everything else silent via `reasonCode=timing`. Rate limiter is dominating.
- `direct-at-silenced` at 97.92% is the dominant signal and the primary gap future branches (R2a/R4-lite) will target.
- 0 errors, 0 timeouts, 0 malformed rows.
- `learned-facts-fts` logged `database disk image is malformed` warnings during FTS rebuild — fallback to vector-only succeeded, does not affect replay correctness.
