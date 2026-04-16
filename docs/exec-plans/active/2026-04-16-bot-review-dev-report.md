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

---

## Tone-Humanize 专项 (A+B+C 组合)

**实施日期：** 2026-04-16
**最终测试状态：** 1690 passed / 15 failed (pre-existing lore-retrieval)
**tsc --noEmit：** clean

### T0：方案 A — persona 词池/例子改写 (e115f14)

**改动：**
- `chat.ts:272`：被调侃时增加接梗等价分支（跟着玩/好奇词池），与反怼概率相当
- `chat.ts:312`：集体称呼三例全换为中性/跟着玩语气（"你们玩什么呢"/"突然好热闹"/"??我也要"），消除居高临下旁观句式
- 未新增 persona 硬规则（净新增 0 条），仅改现有例子和词池排列
- dismissive 拒绝词池（烦/关我屁事/想屁吃）完整保留

**测试：** 5 个 unit test（playful 词池验证、旧例子移除、新例子存在、边界感保留、圈内底线未动）
**mhy 回归：** 15 个 pre-existing failure 不变，无新增退化

### T1：方案 B — 情绪对齐软提示注入 (8770aaa)

**改动：**
- 新增 `detectMoodSignal(recentMessages, windowSize=5)` 函数，检测 playful/tense/null 三档情绪
- 新增 `buildMoodHint(mood)` 生成 user-role 软提示
- 在 `userContent` 组装段注入 mood hint（user-role，非 system-role，不与 persona 冲突）
- 梗词集合含 bandori 圈常用词（嘎嘎/咕咕/草/哈哈/笑死/绷不住 等）
- hint 不含 `<skip>` 控制 token，不向 deflection/mimic 泄漏

**测试：** 11 个 unit test（playful/tense/null 检测、阈值、窗口、混合优先级、空输入、控制 token 隔离）
**mhy 回归：** PASS（无变化）

### T2：方案 C — 骨架级近重复检测 (084c21d)

**改动：**
- 新增 `extractSkeleton(text)` 函数，将内容词替换为 `_`，保留虚词/标点/结构词
- 新增 `skeletonSimilarity(a, b)` 基于 bigram Jaccard 比较骨架
- 在 near-dup 检测段后增加骨架检测，阈值 0.6，窗口 5
- 捕获「你们又在 X 了」/「你们又在 Y 了」等句式重复（bigram Jaccard 漏过的 case）
- 与 echo 检测正交独立，与 P1-7 同批
- 更新 `chat.test.ts` 集体称呼例子断言适配 T0 改动

**测试：** 12 个 unit test（骨架提取、相似度、空字符串、核心用例、不同长度不误判）
**mhy 回归：** PASS（无变化）

### 总计

| 项目 | 数值 |
|------|------|
| 新增 test | 28 (tone-humanize.test.ts) |
| 总 test | 1705 (was 1676) |
| 通过 | 1690 |
| 失败 | 15 (全部 pre-existing) |
| 新增失败 | 0 |
| commit 数 | 3 (e115f14, 8770aaa, 084c21d) |
| 净新增 persona 规则 | 0 |
