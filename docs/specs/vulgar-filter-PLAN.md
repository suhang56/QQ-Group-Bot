# Feature: R2.5.1-annex — On-demand Vulgar-Dismissal Filter + Purge

## Why (Class 3 bait-reflection — data hygiene)

Class 3 bait-reflection (per `feedback_bot_failure_4class_framework.md`): two-layer failure.
- Bottom layer: `on-demand-lookup` cached `你懂个毛` as jargon (`factId=5488`), meaning injected into prompt.
- Top layer: main LLM saw "vulgar dismissal" context + user bait → mirrored `你个屁`.

Fix is **治本 B** (data hygiene): block vulgar-dismissal candidates from entering `on-demand-lookup`
+ purge existing polluted rows. Runtime guard (治标 A) left for R2.5.2 pending observation.

This PR is a **data-hygiene PR**, not a behavior PR. No runtime guards changed. No new replay tags.

## Scope IN

1. New predicate `src/utils/is-vulgar-dismissal.ts` — separate from `is-emotive-phrase.ts` to keep family scopes clean.
2. `_buildOnDemandBlock` filter chain: append `.filter(t => !isVulgarDismissal(t))` after existing `isEmotivePhrase` filter (line 4221 of `chat.ts`).
3. Purge script `scripts/maintenance/purge-vulgar-phrase-facts.ts` — UPDATE only (status→'rejected'), no DELETE, lore-topic rows exempt, default dry-run, `--apply` to persist. Follows PR5 `purge-social-phrase-facts.ts` CLI convention exactly.
4. Tests: predicate unit (positive + negative family), chat-integration (vulgar term yields empty on-demand block), purge dry-run (reports ≥1 including factId=5488), purge --apply (status flipped, lore row untouched).

## Scope OUT

- Runtime bait-reflection guard (R2.5.2 A — pending 24–48h observation after this PR)
- PR2 harassment hard gate: covers `怡你妈 / sb / 滚蛋` (hard curse/threat); overlapping those stems would conflict
- `_buildOnDemandBlock` send-guard-chain: unchanged — this PR only filters candidates, not bot output
- No new replay/analytics tags: data hygiene PRs don't introduce metric instrumentation
- Other emotive-family extensions (R2.5.1 Items 1–5 already merged)

## Must-NOT-fire (≥6)

1. **第三人称** — `他懂个屁 / 她不懂个毛` → predicate checks `你` subject; third-person passes.
2. **User fandom** — `笑死 / 草 / 牛啊 / 梦到了` → `EMOTIVE_ALLOWLIST` already guards; vulgar predicate is additive, doesn't touch allowlist.
3. **Non-vulgar-你 phrases** — `你懂吗 / 你说什么 / 你知道吗` → regex requires trailing vulgar token (`毛/屁/锤子/鬼/啥/蛋`).
4. **Long-sentence embed** — `今天的演出真的懂个毛啊，是什么感觉` → predicate anchored to full-term match (`^…$`); substring in long sentence passes.
5. **lore-topic rows** — topic contains `lore:` → purge WHERE excludes them unconditionally; a fandom term that happens to look vulgar (e.g. future edge) stays.
6. **Ondemand-lookup shortcut cache hit** — term already in `learned_facts` with `topic=ondemand-lookup:你懂个毛`; predicate filters *candidate terms before lookup*, not the DB directly — purge handles the historical rows.
7. **Empty / whitespace input** — `isVulgarDismissal('')` → returns false (guard at top of predicate, mirrors `isEmotivePhrase` pattern).

## Acceptance

- `tsc` clean (strict, project root).
- `vitest` new + full 4116-baseline suite all pass, no regress on R2a/R2.5.1/PR1–5 existing tags.
- Purge dry-run on `data/bot.db` copy: reports ≥1 candidate row including factId=5488; `--verbose` shows topic + fact.
- Purge `--apply`: status flipped to `rejected` for vulgar rows; lore-topic row (if any) untouched.
- No new runtime deps.

## Open Questions for Designer

1. **Regex anchoring**: full-line `^…$` vs prefix `^你` — which maximises recall without long-sentence false-positives?
2. **Purge topic-prefix scope**: limit to `opus-classified:slang:` + `ondemand-lookup:` prefixes, or also `opus-rest-classified:slang:`?
3. **Lore allowlist check**: grep lore for `懂 / 屁 / 锤子` to see if any fandom canonicals overlap — do we need a runtime allowlist beyond the lore-topic WHERE exclusion?
4. **Stem sharing**: `is-vulgar-dismissal.ts` vs extending `emotive-stems.ts` with a `VULGAR_DISMISSAL_STEMS` export — separate module preferred; Designer confirm.
