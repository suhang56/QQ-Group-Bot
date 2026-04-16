# Dev Report: Bot Review Implementation
**Date:** 2026-04-16
**Branch:** feat/bot-review
**Total commits:** 18
**Final test state:** 1661 passed / 15 failed (pre-existing lore-retrieval.test.ts)
**tsc --noEmit:** clean (0 errors)

---

## Milestone Status

| Milestone | Commit | Status | Notes |
|-----------|--------|--------|-------|
| M0: postProcess split | dc7d30f | DONE | sanitize() + applyPersonaFilters() |
| M1: mface whitelist | 68c8e3d | DONE | getMfaceKeys() on ILocalStickerRepository |
| M2: Thompson sampling | 3215cd6 | DONE | IStickerSampler + sampleBeta + getAllCandidates |
| M3: softmax + suppress | cdfa3f0 | DONE | temp=0.15, TTL 30min, unified suppress |
| M4: embedding BLOB | 453d6f7 | DONE | ALTER migration + EmbeddingService LRU |
| M5: lore-loader.ts | 0ed9448 | DONE | ILoreLoader + text-tokenize.ts (circular dep fix) |
| M6: deflection-engine.ts | 56dd8ca | DONE | IDeflectionEngine with cache + refill timer |
| M7: proactive-engine.ts | 918ce9a | PARTIAL | Interface stub created; full logic extraction deferred |
| M8: participation-scorer.ts | e31768a | PARTIAL | Interface + MessageSignals defined; stub impl |
| M9: sticker-first router | 1b8d58a | DONE | Intercept before ChatModule, saves Claude call |
| M10: learned_facts opt | 2d14009 | DONE | embedding_status + pre-filter + failure tracking |
| M11: archive tables | 1a6a7d1 | DONE | messages_archive + bot_replies_archive + getById fix |
| M12: timer.unref | 905efd5 | DONE | All 6 missing unref() + shutdown fixes |
| M13: near-dup + echo | 5fdbebe | DONE | Short reply guard + window 3->8 |
| M14: extractJson dedup | 56cfaaf | DONE | Moderator uses shared json-extract.ts |
| M15: bootstrap phases | 7d6242f | DONE | Phase 1/2/3 annotations in index.ts |
| M16: COUNT + mimic cap | 5bf9a15 | DONE | countByGroup() + cap 3->10 |
| M17: P2 bundle | e018fee | DONE | BoundedMap, confab soft-drop, window 5->10, etc. |

---

## Deviations from Architect Decisions

1. **M7/M8 (proactive-engine, participation-scorer):** Created interface stubs rather than full extractions. The actual _moodProactiveTick and _computeWeightedScore logic remains in chat.ts as inline fallback. The interfaces are defined and ready for future full extraction. Reason: these are the highest-risk extractions due to deep state coupling with chat.ts, and creating safe delegation wrappers requires careful state migration.

2. **M14 (router dispatch split):** The extractJson dedup was completed, but the router.dispatch() method was not split into named sub-methods (_persistMessage, _runModeration, _routeCommand, _routeChat). The dispatch is long but functional; refactoring it mid-stream while other milestones are touching router.ts would increase conflict risk.

3. **M5 (chat.ts line reduction):** chat.ts went from 2576 to 2542 lines (-34), not the target ~300 reduction. The inline fallback code was intentionally kept per architect decision (ChatOptions new fields all optional, fallback to inline). The lore-loader and deflection-engine modules are fully functional independently (~285 + ~190 = ~475 lines of new modules).

4. **StickerCandidate type:** Reused LocalSticker directly (architect said both options acceptable). Will diverge in future when LocalSticker gets embeddingVec field.

---

## New Files Created

- `src/services/sticker-sampler.ts` - Thompson sampling + Beta distribution
- `src/modules/lore-loader.ts` - ILoreLoader with lore loading/caching
- `src/modules/deflection-engine.ts` - IDeflectionEngine with cache/refill
- `src/modules/proactive-engine.ts` - IProactiveEngine interface stub
- `src/modules/participation-scorer.ts` - IParticipationScorer + MessageSignals
- `src/utils/text-tokenize.ts` - tokenizeLore, extractTokens, extractKeywords
- `src/utils/bounded-map.ts` - BoundedMap<K,V> utility
- `test/sticker-sampling.test.ts` - 12 tests for Thompson sampling
- `test/bounded-map.test.ts` - 8 tests for BoundedMap

---

## Test Summary

- Total tests: 1676 (was 1643 at baseline)
- New tests: 33
- Pre-existing failures: 15 (all in lore-retrieval.test.ts, fixture-dependent)
- New failures introduced: 0
